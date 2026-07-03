// Lizard Block Mania leaderboard: one Lambda behind a Function URL.
// GET /top returns the top 50; POST /submit upserts a player's best.
// CORS is handled entirely at the Function URL layer, never here.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { createHash } from 'node:crypto';

const TABLE = process.env.TABLE_NAME;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const RATE_LIMIT_PER_HOUR = 30; // POSTs per IP
const MIN_UPDATE_GAP_SEC = 10;  // between accepted updates per player
const MAX_SCORE = 100000;       // plausibility cap (basic sanity anti-cheat)

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const resp = (status, body) => ({
  statusCode: status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/* Mirrors the client's nickname rules: strip angle brackets, control and
   zero-width characters, collapse whitespace, 1-20 code points. */
function sanitizeName(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const name = raw.normalize('NFC')
    .replace(/[<>\u0000-\u001F\u007F-\u009F\u200B-\u200F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = [...name].length;
  if (points < 1 || points > 20) return null;
  return name;
}

export const handler = async (event) => {
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || '';
  const path = event.rawPath || '/';
  if (method === 'GET' && path === '/top') return top();
  if (method === 'POST' && path === '/submit') return submit(event);
  return resp(404, { error: 'not found' });
};

async function top() {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'top',
    KeyConditionExpression: 'lb = :lb',
    ExpressionAttributeValues: { ':lb': 'LB' },
    ScanIndexForward: false,
    Limit: 50,
  }));
  return resp(200, {
    scores: (out.Items || []).map((it) => ({
      id: it.pk.slice(2),
      name: it.name,
      score: it.score,
      when: it.updatedAt,
    })),
  });
}

async function submit(event) {
  const rawBody = event.body || '';
  if (rawBody.length > 1024) return resp(413, { error: 'too large' });
  let data;
  try { data = JSON.parse(rawBody); } catch (err) { return resp(400, { error: 'bad json' }); }
  if (!data || typeof data !== 'object') return resp(400, { error: 'bad body' });

  const { playerId, secret, score } = data;
  const name = sanitizeName(data.name);
  if (typeof playerId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(playerId)) {
    return resp(400, { error: 'bad playerId' });
  }
  if (typeof secret !== 'string' || !/^[0-9a-f]{32}$/.test(secret)) return resp(400, { error: 'bad secret' });
  if (!name) return resp(400, { error: 'bad name' });
  if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) return resp(400, { error: 'bad score' });

  /* Per-IP hourly counter; DynamoDB TTL sweeps the rows */
  const ip = (event.requestContext && event.requestContext.http && event.requestContext.http.sourceIp) || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const rl = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: 'RL#' + ip + '#' + Math.floor(now / 3600) },
    UpdateExpression: 'ADD #n :one SET #t = if_not_exists(#t, :ttl)',
    ExpressionAttributeNames: { '#n': 'n', '#t': 'ttl' },
    ExpressionAttributeValues: { ':one': 1, ':ttl': now + 7200 },
    ReturnValues: 'ALL_NEW',
  }));
  if (((rl.Attributes && rl.Attributes.n) || 0) > RATE_LIMIT_PER_HOUR) return resp(429, { error: 'slow down' });

  /* One row per player. First submit pins the secret hash; afterwards the
     same secret, a strictly better score, and a 10s gap are all required. */
  const secretHash = sha256(secret);
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: 'P#' + playerId },
      UpdateExpression: 'SET #n = :name, score = :score, lb = :lb, updatedAt = :now, '
        + 'secretHash = if_not_exists(secretHash, :hash), createdAt = if_not_exists(createdAt, :now)',
      ConditionExpression: 'attribute_not_exists(pk) OR (secretHash = :hash AND score < :score AND updatedAt <= :cutoff)',
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: {
        ':name': name,
        ':score': score,
        ':hash': secretHash,
        ':lb': 'LB',
        ':now': now,
        ':cutoff': now - MIN_UPDATE_GAP_SEC,
      },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    }));
    return resp(200, { accepted: true, best: score });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      const old = err.Item ? unmarshall(err.Item) : null;
      if (!old || old.secretHash !== secretHash) return resp(403, { error: 'not yours' });
      if (score <= old.score) return resp(200, { accepted: false, best: old.score });
      return resp(429, { error: 'too soon' });
    }
    throw err;
  }
}

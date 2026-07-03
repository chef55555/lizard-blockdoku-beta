# Leaderboard backend: deploy runbook

Everything needed to stand up the Lizard Block Mania leaderboard on AWS
from any computer. The code is already in this repo:

- `backend/index.mjs`: the Lambda handler (GET /top, POST /submit)
- `infra/template.yml`: CloudFormation for the table, role, function, and Function URL
- `infra/budget.json` + `infra/budget-notifications.json`: $1/month billing tripwire
- `game.js`: `LEADERBOARD_URL` near the top is an empty string, which keeps the
  whole feature disabled until you paste the Function URL in (step 7)

Region for everything: **us-east-1**. Total cost at friends-and-family
traffic: $0/month (Lambda + Function URL free tier is permanent; the
DynamoDB table is on-demand and tiny).

## 0. Prerequisites on the new machine

1. Clone the repo and check out the `v2` branch (or `main` after v2 ships).
2. Install the AWS CLI v2: `winget install Amazon.AWSCLI` on Windows, or
   see https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
3. Open a FRESH terminal afterwards so `aws` is on PATH.

## 1. Credentials (one-time, manual)

Do not use root account keys.

1. AWS console > IAM > Users > Create user `thomas-cli`.
2. Attach the `AdministratorAccess` managed policy directly.
3. Create an access key (use case: Command Line Interface).
4. Run `aws configure`: paste the key ID and secret, region `us-east-1`,
   output `json`.
5. Verify: `aws sts get-caller-identity` should print your account ID.

## 2. Deploy the stack

From the repo root:

```
aws cloudformation deploy --stack-name lizard-leaderboard --template-file infra/template.yml --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset
```

## 3. Push the real Lambda code

The template only holds a placeholder; the real handler is pushed after
every stack deploy. PowerShell:

```powershell
Compress-Archive -Path backend\index.mjs -DestinationPath backend\fn.zip -Force
aws lambda update-function-code --function-name lizard-leaderboard --zip-file fileb://backend/fn.zip
```

bash equivalent: `cd backend && zip fn.zip index.mjs && aws lambda update-function-code --function-name lizard-leaderboard --zip-file fileb://fn.zip`

Do not commit `fn.zip`.

## 4. Get the Function URL

```
aws cloudformation describe-stacks --stack-name lizard-leaderboard --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" --output text
```

It looks like `https://xxxxxxxx.lambda-url.us-east-1.on.aws/`.

## 5. Smoke the API

> **PowerShell gotcha:** `curl.exe -d '{"...json..."}'` mangles the quotes and
> the Lambda replies `{"error":"bad json"}` / HTTP 400. Use `Invoke-RestMethod
> -Body $body` for the POST cases below (GET is fine with either).

Set `$U` to the Function URL (no trailing slash needed; trim one if present).

```powershell
# empty board initially
Invoke-RestMethod "$U/top"                       # expect scores: []

# a valid submit (playerId is any UUID, secret is any 32 hex chars)
$body = '{"playerId":"11111111-2222-3333-4444-555555555555","secret":"0123456789abcdef0123456789abcdef","name":"Test","score":150}'
Invoke-RestMethod -Method Post -Uri "$U/submit" -ContentType 'application/json' -Body $body
# expect accepted: true, best: 150

# same score again: not an improvement
Invoke-RestMethod -Method Post -Uri "$U/submit" -ContentType 'application/json' -Body $body
# expect accepted: false, best: 150

# wrong secret for the same playerId: 403
$evil = $body.Replace('0123456789abcdef0123456789abcdef', 'ffffffffffffffffffffffffffffffff')
try { Invoke-RestMethod -Method Post -Uri "$U/submit" -ContentType 'application/json' -Body $evil } catch { $_.Exception.Response.StatusCode }

# CORS preflight must echo the github.io origin
curl.exe -s -i -X OPTIONS "$U/submit" -H "Origin: https://chef55555.github.io" -H "Access-Control-Request-Method: POST" | Select-String "access-control"
```

Clean up the test row afterwards (optional):

```
aws dynamodb delete-item --table-name lizard-leaderboard --key "{\"pk\":{\"S\":\"P#11111111-2222-3333-4444-555555555555\"}}"
```

## 6. Billing tripwire

```
aws budgets create-budget --account-id YOUR_ACCOUNT_ID --budget file://infra/budget.json --notifications-with-subscribers file://infra/budget-notifications.json
```

`YOUR_ACCOUNT_ID` comes from `aws sts get-caller-identity`. The first two
budgets on an account are free. Alerts email thomas.sheffer@gmail.com at
50% and 100% of $1.

## 7. Wire the game to it

1. In `game.js`, set the Function URL (keep the test hook):
   `const LEADERBOARD_URL = (typeof window !== 'undefined' && window.__LB_URL__) || 'https://xxxxxxxx.lambda-url.us-east-1.on.aws';`
   (no trailing slash)
2. Bump `CACHE` in `sw.js` (mandatory on every deploy).
3. Run `node tests/logic.test.js` and `node tests/smoke.mjs`
   (smoke needs `python -m http.server 8080` serving the repo).
4. Commit, push to the beta repo (`git push beta v2:main`), verify with
   `node tests/live-check.mjs https://chef55555.github.io/lizard-blockdoku-beta/`.
5. Note: the browser can only call the API from `https://chef55555.github.io`
   because CORS is pinned there. The beta site can VIEW the top 50 but never
   submits (IS_BETA guard); real submits only happen from the production URL.

## Gotchas from the first real deploy (2026-07-03, account 172627761914)

- **Function URL returned 403 `AccessDeniedException` on every GET/POST** even
  though `AuthType` was `NONE` and the `lambda:InvokeFunctionUrl` grant for
  `Principal: '*'` was present. Fix: the resource policy ALSO needs a plain
  `lambda:InvokeFunction` grant for `Principal: '*'` (no `FunctionUrlAuthType`
  condition — AWS rejects that flag on this action). Both statements are now in
  `template.yml` (`FnUrlPermission` + `FnInvokePermission`), so a fresh deploy
  is fine. Direct `aws lambda invoke` worked the whole time — that isolates a
  403 like this to the URL auth layer, not your handler.
- The AWS CLI installs to `C:\Program Files\Amazon\AWSCLIV2\aws.exe`. If `aws`
  isn't on PATH yet, call it by that full path.

## Design notes (for future maintenance)

- One DynamoDB row per player (`pk = P#<uuid>`), so the board dedupes itself.
- First submit pins `secretHash` (sha256 of the client secret); later updates
  require the same secret, a strictly higher score, and a 10s gap, enforced in
  a single conditional UpdateItem.
- Rate limiting: 30 POSTs per IP per hour via counter rows with DynamoDB TTL.
- Anti-cheat is plausibility-only (score cap 100000) by design: accepted risk
  for a friends-only board.
- CORS lives entirely on the Function URL config in the template; the Lambda
  code never sets CORS headers.
- The client identity lives in localStorage key `lizard-blockdoku-lb`
  (playerId, secret, bestSubmitted). Clearing it mints a new identity and
  the old row becomes orphaned but harmless.

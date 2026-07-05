/* Release notes shown from Settings ("What's new"). Latest release first.
   Every user-visible change ships with an entry here (see CLAUDE.md). */

const RELEASE_NOTES = [
  {
    version: 'v2.5',
    date: '2026-07-05',
    notes: [
      'Reach the top faster: as you drag a piece upward it now leads further ahead of your finger, so you barely have to move to place along the top rows.',
      'Changed your mind about a freeze? A dipped piece now shows a ✕ to un-dip it and get the Freeze back.',
    ],
  },
  {
    version: 'v2.4',
    date: '2026-07-04',
    notes: [
      'New item: Flip! Mirrors a tray piece left-to-right. One for every 300 points, and flipping back returns it.',
      'Smoother dragging on iPhone/Safari: pieces track your finger and land exactly where you drop them, instead of skittering around or missing the cell.',
      'Honest previews: a dipped piece now glows icy blue over the sets it will freeze, instead of promising a clear it will not make.',
      'Smarter stuck hints: the game now knows when a Flip, or a Rotate and Flip together, is your way out.',
      'Freeze fix: a dip that freezes nothing new now returns the Freeze AND lets the waiting sets melt, instead of holding them for free.',
      'Freeze rescue: when the board fills up while a frozen combo is waiting, it now melts to save you with a clear message, so the big save no longer looks like a surprise wipe.',
      'A held Flip now counts when the game checks whether you are truly stuck.',
      'Tutorial fix: tapping Undo before placing the piece no longer strands the walkthrough with an empty tray.',
      'This "What’s new" list, right here in Settings.',
      'Beta: a Test scenarios panel with preset boards, piece and icon filters, and a 1x1-reroll switch.',
      'Beta: one-tap bug reports that capture the board, the state before your last move, and a log of recent moves, ready to paste or share.',
    ],
  },
  {
    version: 'v2.3',
    date: '2026-07-04',
    notes: [
      'Game over got smarter: it knows when a Rotate or a held Reroll can still save you, and the way out pulses.',
      'Freezes stack: keep dipping pieces and melt everything as one giant combo.',
      'Pieces follow your finger instantly, and Perfect Matches celebrate with per-icon flourishes.',
      'The tutorial teaches 3x3 boxes, your save gets an extra backup, and Settings can reset all data.',
    ],
  },
  {
    version: 'v2.2',
    date: '2026-07-03',
    notes: [
      'New item: Reroll! Swap a tray piece for a fresh one.',
      'New U piece and a butterfly icon joined the board.',
      'Freezes are easier to earn, scoring help shows worked examples, and new panels track recent scores and streaks.',
      'A hands-on tutorial walks through every move and item.',
    ],
  },
  {
    version: 'v2.1',
    date: '2026-07-03',
    notes: [
      'Pieces pop out from under your finger when picked up.',
      'Streaks: clear on back-to-back placements for rising bonuses.',
      'Rotations can be spun back to cancel for a refund, and everything sounds louder and juicier.',
    ],
  },
  {
    version: 'v2.0',
    date: '2026-07-03',
    notes: [
      'Items arrived: Rotate, Undo, and Freeze, earned by playing well.',
      'A global leaderboard, an interactive tutorial, and escalating clear celebrations.',
      'Settings with volume, light/dark themes, and a nickname.',
    ],
  },
  {
    version: 'v1.0',
    date: '2026-07-02',
    notes: [
      'The first release: a pink and purple Blockudoku with icon match bonuses, made with love for Lizard.',
    ],
  },
];

export { RELEASE_NOTES };

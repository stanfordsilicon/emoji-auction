// The 20 emoji the game is allowed to use. No suggested keywords are shown
// to players — entries are free text with nothing seeding or biasing what
// they write, since the whole point of keywordstats (see ./mongo.js) is
// noticing which free-text words independently converge on the same emoji
// across unrelated games.
const EMOJIS = [
  '🤣', '😘', '👏', '😳', '😎', '👌', '💪', '😏', '💯', '😜',
  '😐', '😇', '💰', '😑', '💩', '👋', '🌈', '👊', '🥹', '😙',
];

module.exports = { EMOJIS };

// The 20 emoji the game is allowed to use, each with a few example
// association words pulled from the source keyword survey. `hints` is purely
// a light "e.g. ..." nudge shown under the writing input — entries are free
// text, never validated against this list, since the whole point of
// keywordstats (see ../data/mongo.js) is noticing which free-text words
// independently converge on the same emoji across unrelated games.
const EMOJIS = [
  { emoji: '🤣', hints: ['crying', 'funny', 'haha', 'hilarious', 'laugh'] },
  { emoji: '😘', hints: ['bae', 'flirt', 'kiss', 'love', 'muah'] },
  { emoji: '👏', hints: ['applause', 'clap', 'congrats', 'nice', 'well done'] },
  { emoji: '😳', hints: ['awkward', 'dazed', 'flushed', 'impressed', 'wow'] },
  { emoji: '😎', hints: ['cool', 'rad', 'shades', 'swag', 'chilling'] },
  { emoji: '👌', hints: ['awesome', 'dope', 'legit', 'ok', 'sweet'] },
  { emoji: '💪', hints: ['flex', 'gains', 'gym', 'strong', 'muscle'] },
  { emoji: '😏', hints: ['smirk', 'sly', 'suave', 'boss', 'shade'] },
  { emoji: '💯', hints: ['100', 'agree', 'perfect', 'truth', 'yup'] },
  { emoji: '😜', hints: ['wink', 'joke', 'silly', 'yolo', 'wacky'] },
  { emoji: '😐', hints: ['blank', 'meh', 'neutral', 'awkward', 'whatever'] },
  { emoji: '😇', hints: ['angel', 'blessed', 'innocent', 'halo', 'peaceful'] },
  { emoji: '💰', hints: ['money', 'cash', 'rich', 'bank', 'win'] },
  { emoji: '😑', hints: ['dead', 'unimpressed', 'meh', 'uh', 'straight face'] },
  { emoji: '💩', hints: ['poop', 'stinky', 'bs', 'trash', 'gross'] },
  { emoji: '👋', hints: ['bye', 'hi', 'wave', 'hello', 'later'] },
  { emoji: '🌈', hints: ['pride', 'rainbow', 'lgbtq', 'colorful', 'weather'] },
  { emoji: '👊', hints: ['fist bump', 'agree', 'bro', 'punch', 'respect'] },
  { emoji: '🥹', hints: ['grateful', 'aww', 'holding back tears', 'proud', 'emotional'] },
  { emoji: '😙', hints: ['kiss', 'flirt', 'love', 'date', 'sweet'] },
];

module.exports = { EMOJIS };

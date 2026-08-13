// i18n runtime for Emoji Auction.
//
// English-only for now -- there's no language switcher in this game yet.
// I18N_STRINGS.en is the single source of truth for every piece of UI
// text; more languages get added as new blocks here (I18N_STRINGS.es,
// etc.) once translations come back. The clean key -> English export
// handed off for translation lives at ../i18n-source/en.json (repo root,
// outside public/, so it's never part of what actually gets deployed) --
// keep that file's keys in sync with this one.
//
// t(key, vars) looks up a string and fills in any {placeholder} tokens
// (e.g. t('round_badge', { round: 2, total: 3 })). Falls back to the raw
// key if it's ever missing, so a typo shows up as visibly broken text
// instead of silently rendering nothing.
const I18N_LANG = 'en';

const I18N_STRINGS = {
  en: {
    back_to_launchpad: "RETURN TO LAUNCH PAD",
    loading: "LOADING",
    app_title: "Emoji Auction",
    app_tagline: "Write it. Bet on it. Vote for it. Cash in.",
    username_label: "Your name",
    username_placeholder: "Player1234",
    create_room_button: "Create Room",
    divider_or: "or",
    room_code_label: "Room code",
    room_code_placeholder: "ABCD",
    join_room_button: "Join Room",
    invited_hint: "Invited to room {code} — enter a name and join!",
    generic_error: "Something went wrong.",
    connection_error: "Connection error — please try again.",
    session_expired: "That game session isn't available anymore — please rejoin or start a new game.",
    lobby_title: "Room Code",
    copy_invite_button: "📋 Copy Invite Link",
    invite_link_copied: "Invite link copied!",
    players_heading: "Players",
    host_suffix: "(host)",
    you_suffix: "(you)",
    ready_badge: "✅ Ready",
    waiting_badge: "⏳ Waiting",
    ready_up_button: "✅ Ready Up",
    cancel_ready_button: "Cancel Ready",
    start_game_button: "Start Game",
    lobby_waiting_host_ready: "Everyone is ready — start when you are!",
    lobby_waiting_guest_ready: "Waiting for the host to start the game…",
    lobby_waiting_not_ready: "Waiting for everyone to be ready…",
    topbar_phase_writing: "Writing",
    topbar_phase_betting: "Betting",
    topbar_phase_voting: "Voting",
    topbar_phase_results: "Results",
    round_badge: "Round {round} / {total}",
    room_code_caption: "Room Code",
    writing_title: "Describe the emoji!",
    writing_max_words_suffix: "(up to {max} words)",
    writing_placeholder: "enter word",
    lock_in_button: "🔒 Lock In",
    cancel_lock_in_button: "Cancel Lock In",
    locked_in_count: "{count}/{total} locked in",
    betting_title: "Bet on the best words!",
    entry_pool_label: "💰 {pool} chips bet",
    entry_odds_value: "{odds}x",
    entry_no_bets_yet: "no bets yet",
    entry_own_no_bet: "This is your entry — you can't bet on it.",
    entry_co_authored_note: "You also wrote this — betting is open since someone else matched it.",
    my_bet_badge: "Your bet: {amount} chips",
    bet_amount_placeholder: "min {min}",
    bet_update_button: "Update",
    bet_button: "Bet",
    bet_clear_button: "Clear",
    bet_amount_required: "Enter a chip amount first.",
    voting_title: "Vote on the best words!",
    entry_own_no_vote: "This is your entry — you can't vote for it.",
    reveal_next_button: "Reveal Next ▶",
    leaderboard_heading: "Leaderboard",
    next_round_button: "Next Round",
    see_final_results_button: "See Final Results",
    reveal_waiting_host: "Waiting for the host…",
    reveal_nobody_wrote: "Nobody wrote anything this round!",
    reveal_words_up_for_vote_one: "{count} word up for vote.",
    reveal_words_up_for_vote_other: "{count} words up for vote.",
    reveal_winner_badge: "🏆 Winner",
    written_by: "Written by {authors}",
    votes_and_pool_line_one: "❤️ {votes} vote · 💰 {pool} chips bet",
    votes_and_pool_line_other: "❤️ {votes} votes · 💰 {pool} chips bet",
    author_bonus_split: "+{amount} chips split between the authors",
    author_bonus_single: "+{amount} chips to the author",
    payout_line: "+{amount} chips paid out to backers",
    round_results_title: "Round {round} Results",
    final_round_results_title: "Final Round Results",
    final_results_title: "🏆 Final Results",
    play_again_button: "🔁 Play Again",
    final_waiting: "Waiting for the host to start a new game…",
    go_home_button: "Go Home",
    leave_game_confirm: "Leave this game?",
  },
};

function t(key, vars) {
  const table = I18N_STRINGS[I18N_LANG] || I18N_STRINGS.en;
  let text = (table && table[key]) || I18N_STRINGS.en[key] || key;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      text = text.split(`{${k}}`).join(vars[k]);
    });
  }
  return text;
}

// Applies every static (non-templated) string in one pass on load --
// anything with dynamic content (a score, a room code, a countdown) is set
// directly by client.js via t() instead, since data-i18n has no way to
// carry variables.
function applyStaticTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
}

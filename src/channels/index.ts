// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord

// gmail

// slack

// telegram

// signal
import './signal.js';

// whatsapp — disabled 2026-05-12 in favor of Signal (privacy + stability).
// Source preserved in whatsapp.ts for one-commit rollback if Signal fails.
// To re-enable: uncomment the import below + restart.
// import './whatsapp.js';

// emacs
import './emacs.js';

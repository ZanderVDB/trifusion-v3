// ─── EMAIL CONFIGURATION ─────────────────────────────────────────────────────
// 1. Sign up free at https://resend.com
// 2. Go to API Keys and create a key
// 3. Paste it below
// 4. Set the email addresses for each person
// 5. Set FROM_EMAIL to an email on a domain you own
//    (or use onboarding@resend.dev for testing — sends to your own email only)

module.exports = {
  RESEND_API_KEY: 're_YOUR_API_KEY_HERE',   // paste your Resend API key here

  FROM_EMAIL: 'Trifusion <onboarding@resend.dev>',

  // ── TESTING (no domain verified) ─────────────────────────────────────────
  // Set YOUR_EMAIL to your own Gmail. All notifications go there for now.
  // When you verify a domain at resend.com/domains, swap in real addresses below.
  YOUR_EMAIL: 'zander.vanderberg1@gmail.com',

  // Email addresses for each user
  // While testing: set all of these to your own Gmail address
  // When live: replace with real addresses
  EMAILS: {
    admin:   'zander.vanderberg1@gmail.com',
    david:   'zander.vanderberg1@gmail.com',
    brigade: 'zander.vanderberg1@gmail.com',
    zamaka:  'zander.vanderberg1@gmail.com',
  }
};

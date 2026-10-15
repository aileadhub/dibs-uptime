# Dibs uptime

Checks Dibs every 5 minutes from outside its own servers and raises the alarm if it stops working.

**What it checks:** the forms' settings (which need the database), the form script, the dashboard and the website.

**When something fails twice in a row (45 seconds apart):**
- a Slack message,
- an email to everyone on the alert list,
- a phone call when the forms themselves are down,
- an issue in this repository, which is the outage record.

While the outage lasts, a reminder goes out every 30 minutes (up to 3 calls in all). A "back up" message goes out when everything passes again.

**Test it:** Actions, Dibs uptime, Run workflow, tick "Send a test alert".

All keys and addresses are repository secrets: `BREVO_API_KEY`, `ALERT_EMAILS`, `SLACK_WEBHOOK_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `ALERT_PHONES`.

Started after the 15 October 2026 outage, when the database froze for 7 hours and every alarm lived inside it.

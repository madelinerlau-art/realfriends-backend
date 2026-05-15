require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const twilio = require("twilio")(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const sgMail = require("@sendgrid/mail");
const { v4: uuidv4 } = require("uuid");
const Database = require("better-sqlite3");
const path = require("path");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app = express();
const db = new Database(path.join(__dirname, "realfriends.db"));

// ---------- DB setup ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    message_key TEXT NOT NULL,
    recipient_type TEXT NOT NULL,
    recipient_value TEXT NOT NULL,
    payment_intent_id TEXT UNIQUE,
    paid INTEGER DEFAULT 0,
    delivered INTEGER DEFAULT 0,
    deliver_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ---------- The 3 messages ----------
const MESSAGES = {
  so: {
    id: "so",
    shortTitle: "I don't like your S.O.",
    fullText:
      "I don't like your significant other. I care about you too much to keep pretending. Something feels off, and I think you deserve to know that someone who loves you sees it.",
    emoji: "💔",
  },
  proud: {
    id: "proud",
    shortTitle: "I'm proud of you",
    fullText:
      "I don't say this enough — I'm genuinely proud of you. Not for the obvious stuff. For the quiet hard things you do that most people never notice. You're doing better than you think.",
    emoji: "🤍",
  },
  sorry: {
    id: "sorry",
    shortTitle: "I'm sorry I wasn't there",
    fullText:
      "I wasn't there for you the way I should have been, and I think about it more than you know. I don't have a good excuse. I just want you to know I see it, and I'm sorry.",
    emoji: "🕊️",
  },
};

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json());

// ---------- Create Stripe checkout ----------
app.post("/api/create-payment-intent", async (req, res) => {
  const { messageKey, recipientType, recipientValue } = req.body;

  if (!MESSAGES[messageKey]) return res.status(400).json({ error: "Invalid message" });
  if (!["phone", "email"].includes(recipientType))
    return res.status(400).json({ error: "Invalid recipient type" });
  if (!recipientValue) return res.status(400).json({ error: "Recipient required" });

  const pendingId = uuidv4();

  // Random delay: 1 min to 4 hours (in seconds from now)
  const minDelay = 60;
  const maxDelay = 4 * 60 * 60;
  const delaySeconds = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
  const deliverAt = Math.floor(Date.now() / 1000) + delaySeconds;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 100, // $1.00
      currency: "usd",
      metadata: {
        pendingId,
        messageKey,
        recipientType,
        recipientValue,
      },
    });

    db.prepare(
      `INSERT INTO messages (id, message_key, recipient_type, recipient_value, payment_intent_id, deliver_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(pendingId, messageKey, recipientType, recipientValue, paymentIntent.id, deliverAt);

    res.json({ clientSecret: paymentIntent.client_secret, pendingId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Payment setup failed" });
  }
});

// ---------- Stripe webhook: payment confirmed ----------
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;
      db.prepare(`UPDATE messages SET paid = 1 WHERE payment_intent_id = ?`).run(pi.id);
      console.log(`Payment confirmed for PI: ${pi.id}`);
    }

    res.json({ received: true });
  }
);

// ---------- View a message (receiver opens link) ----------
app.get("/api/message/:id", (req, res) => {
  const row = db
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .get(req.params.id);

  if (!row) return res.status(404).json({ error: "Message not found" });
  if (!row.paid) return res.status(402).json({ error: "Payment pending" });

  const msg = MESSAGES[row.message_key];
  res.json({
    messageKey: row.message_key,
    shortTitle: msg.shortTitle,
    fullText: msg.fullText,
    emoji: msg.emoji,
  });
});

// ---------- Background delivery job ----------
async function deliverPendingMessages() {
  const now = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE paid = 1 AND delivered = 0 AND deliver_at <= ?`
    )
    .all(now);

  for (const row of rows) {
    const linkUrl = `${process.env.FRONTEND_URL}/m/${row.id}`;
    const smsBody = `No, this isn't spam. One of your friends just has something real to say to you: ${linkUrl}`;
    const emailSubject = "a real friend has something to say";
    const emailText = `No, this isn't spam.\n\nOne of your friends just has something real to say to you:\n\n${linkUrl}`;

    try {
      if (row.recipient_type === "phone") {
        await twilio.messages.create({
          body: smsBody,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: row.recipient_value,
        });
      } else {
        await sgMail.send({
          to: row.recipient_value,
          from: { email: process.env.FROM_EMAIL, name: "real friends" },
          subject: emailSubject,
          text: emailText,
          html: `<p style="font-family:Georgia,serif;font-size:18px;line-height:1.6;color:#1a1a1a;max-width:480px;margin:60px auto;">
            No, this isn't spam.<br><br>
            One of your friends just has something real to say to you:<br><br>
            <a href="${linkUrl}" style="color:#c0392b;font-weight:bold;">${linkUrl}</a>
          </p>`,
        });
      }

      db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`).run(row.id);
      console.log(`Delivered message ${row.id} to ${row.recipient_value}`);
    } catch (err) {
      console.error(`Delivery failed for ${row.id}:`, err.message);
    }
  }
}

// Check every 30 seconds
setInterval(deliverPendingMessages, 30_000);
deliverPendingMessages(); // run immediately on start

// ---------- Start ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));

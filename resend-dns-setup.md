# Verifying terraflooring.com.au in Resend

Follow this with Resend open in one tab and GoDaddy in another.

---

## What I can already see about your setup

I looked up your live DNS, so this is your actual situation, not a generic guide.

| Thing | What it is |
| --- | --- |
| Domain host (where you edit DNS) | **GoDaddy** |
| Email host (your inboxes) | **Google Workspace** |
| Current SPF | Managed by GoDaddy's "SPF Merge" feature |
| DMARC | Present, set to `p=none`, reports going to Brevo |
| Resend records | **Not there yet.** This is what we're adding. |

**The good news.** I warned you earlier about editing your existing SPF record and the danger of breaking your Gmail. That does not apply. Resend puts its SPF on a **subdomain** (`send.terraflooring.com.au`), not on the root. So we never touch your existing SPF, and we never touch your MX records. Your Google Workspace mail cannot break from anything in this guide.

---

## What "verifying" actually means

Right now, anyone in the world can type an email claiming to be from terraflooring.com.au. Nothing stops them. Gmail knows this, which is why unproven mail goes to spam.

Verifying is you leaving a note in your domain's public records saying "Resend is allowed to send as me." Gmail reads that note and trusts the mail. That's it. Three records, five minutes, done once, never again.

---

## Step 1, add the domain in Resend

1. Log in to resend.com
2. Left sidebar → **Domains**
3. **Add Domain**
4. Type `terraflooring.com.au` (the domain, not an email address)
5. Region: pick **Tokyo (ap-northeast-1)**, the closest one to Australia. Lower latency, nothing else changes.
6. **Add**

Resend now shows you a table of DNS records. Leave that tab open.

---

## Step 2, what those records are

You'll see roughly three rows. In plain English:

| Record | What it does |
| --- | --- |
| **TXT** on `resend._domainkey` | The signature key. Every email gets stamped with it so it can't be faked. This is the important one. |
| **MX** on `send` | Catches bounces so we know which addresses are dead. Note: on the `send` subdomain, **not** your main domain. |
| **TXT** on `send` | The SPF for that subdomain. Again, subdomain only. |

**If Resend ever shows you an MX record with a blank name, or a name that's just `@` or `terraflooring.com.au`, stop and send me a screenshot.** That would overwrite the records delivering your inbox. It shouldn't happen, but that's the one mistake that takes your email down, so I'd rather you check with me.

---

## Step 3, add them at GoDaddy

1. Sign in to GoDaddy
2. **Domain Portfolio** → click `terraflooring.com.au`
3. **DNS** (or "Manage DNS")
4. **Add New Record** for each of the three

For each one:

- **Type** → match what Resend says (TXT or MX)
- **Name** → copy from Resend, but see the warning below
- **Value** → copy exactly from Resend, use the copy button, don't retype
- **Priority** (MX only) → whatever Resend shows, usually 10
- **TTL** → leave default, or 1 hour

### The one GoDaddy trap

GoDaddy adds your domain to the name automatically. So in the **Name** box you type only the short bit:

- Type `resend._domainkey` &nbsp;&nbsp;✅
- Not `resend._domainkey.terraflooring.com.au` &nbsp;&nbsp;❌

Get that wrong and you end up with `resend._domainkey.terraflooring.com.au.terraflooring.com.au`, which verifies nothing. If Resend shows the full domain in its Name column, delete the `.terraflooring.com.au` part before pasting.

### Ignore GoDaddy's SPF helper

GoDaddy may offer to "manage your email senders" or add Resend to its SPF merge. Don't use it. The records Resend gave you are all you need, and the helper edits your root SPF, which is the thing we're deliberately leaving alone.

---

## Step 4, verify

Back in Resend, hit **Verify DNS Records**.

Usually goes green in a few minutes. GoDaddy can be slow, so if it's still pending, wait an hour and press it again. Nothing is broken, it's just propagation.

Once it's green, tell me and I'll fire a live test email to team@terraflooring.com.au from inside Terra Ops. That's the real proof, not the green tick.

---

## Something I found while looking, worth knowing later

Your domain currently authorises four different services to send email as you:

- **MailerSend**
- **SparkPost**
- **Brevo** (also receiving your DMARC reports)
- **Zoho** (a leftover verification record)

Someone set these up at some point and they appear to be dormant. Two reasons to care, neither urgent:

1. **Security.** Anyone with access to those old accounts can still send email that looks like it came from Terra Flooring.
2. **Deliverability.** A long list of authorised senders, most unused, is a mild negative signal to spam filters.

Once Resend is verified and sending happily, I'd strip out the ones you don't use and tighten DMARC from `p=none` to `p=quarantine` so forged Terra email actually gets blocked instead of just noted. That's a separate, later job. Don't touch it now, changing SPF and DMARC while we're mid-setup is how you end up debugging two things at once.

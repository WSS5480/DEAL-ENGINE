# School Scheduler — who logs in where

### IntAlsoft · reference only — no passwords are written in this file

Base URL: `https://after-school-scheduler.onrender.com`

> This file lives in a public repository. Nothing secret goes in it. Every real
> value lives in **Render → after-school-scheduler → Environment**.

---

## 1 · YOUR office (platform owner — only you)

| | |
|---|---|
| **URL** | `/office` **or** `/owner` |
| **Email** | the `OWNER_EMAIL` env var |
| **Password** | the `OWNER_PASSWORD` env var |

This is the IntAlsoft console: every school, alerts, the trial-code generator,
support inbox, email status. Completely separate from any school login — school
admins get a 401 if they try to reach it.

If `OWNER_PASSWORD` is ever unset the app falls back to a built-in default and
flags it as unsafe on your office health screen. Set it and keep it set.

---

## 2 · A SCHOOL's admin (one per school — they create it themselves)

| | |
|---|---|
| **URL** | the school's own link, e.g. `/patriots-high-school` |
| **Login** | the email + password **they** chose when they registered the school |

You never hold a school's password. If a principal locks themselves out, you reset it
from your office: **Schools → Reset admin PW** — that hands you a temporary password
to send them.

---

## 3 · Teachers & students (inside one school)

| | |
|---|---|
| **URL** | their school's link, e.g. `/patriots-high-school` |
| **Login** | their own email + password |

Three ways they get an account — all from **Admin** tab in the school's console:

1. Admin adds them one at a time
2. Admin pastes/uploads a roster list
3. Admin invites them by email — they set their own password

Anyone the admin adds is pre-approved. Anyone who self-registers waits in **Approvals**.

---

## 4 · Demo school

The demo school at `/demo` exists so you can show the product without touching a
real school. Its logins are seeded by the app itself — read them from your office,
not from this file, and never reuse them for anything real.

---

## 5 · What you hand out vs what stays secret

**Give to a school**

- Their school link (`/their-slug`)
- An access code, when you're giving a trial — minted in your office → Access codes
- Nothing else. They make their own passwords.

**Never leave Render → Environment**

- `OWNER_EMAIL` / `OWNER_PASSWORD` — your console login
- `CODE_SECRET` — signs access codes; anyone with it can mint free Pro
- `JWT_SECRET` — signs every login session
- `UPGRADE_CODE` — the permanent unlock code
- `EMAIL_USER` / `EMAIL_PASSWORD` — your Gmail + app password
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` — money
- `PARTNER_KEY` — lets IntAlsoft HQ read this app's numbers
- `APP_SECRET_SCHEDULER` — how this app proves itself to My Apps

None of these belong in the code or in this file.

---

## 6 · Quick links

| What | Where |
|---|---|
| Your office | `/office` |
| Storefront (public) | `/` |
| Demo school | `/demo` |
| Privacy statement | `/privacy` |
| Set env vars | Render → after-school-scheduler → Environment |
| Repo | github.com/WSS5480/AFTER-SCHOOL-SCHEDULER |

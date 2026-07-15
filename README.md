# Safwah API

> **A thin Express + MongoDB backend for the Safwah tourist-payments app — rates, transactions, spending analytics, and profiles, so the mobile client never holds the database credential.**

## Overview

Safwah API is a small, single-file Node.js service that backs a UAE tourist-focused
payments app. It exposes AED/USDT peg rates, a transaction ledger, spending
analytics (including reclaimable VAT), and user profiles behind a simple REST
interface. It connects to MongoDB Atlas when available and transparently falls
back to an in-memory store when the database is unreachable, so demos keep
working without any infrastructure. The project is intentionally lean — one
`index.js`, no framework beyond Express, and a full integration test suite built
on Node's built-in test runner.

## Features

- **AED/USDT rate endpoint** — serves the AED-to-USD peg (~3.6725) and USDT≈USD, stamped with an update timestamp.
- **Transaction ledger** — list the 50 most recent transactions (newest-first) and post new ones, with sensible `status`/`ts` defaults.
- **Spending analytics** — `/stats` aggregates completed spend into totals, reclaimable VAT, and breakdowns by category and token.
- **User profiles** — fetch and patch per-address profiles (loyalty tier, SFL points, etc.) with case-insensitive address handling and upsert-on-write.
- **Resilient storage** — uses MongoDB Atlas when reachable; otherwise falls back to a seeded in-memory store so the app still runs.
- **Deterministic tests** — integration tests drive the real Express app over HTTP on an ephemeral port with zero external dependencies, wired into GitHub Actions CI.

## Tech Stack

- **Runtime:** Node.js (ES modules, `--env-file`, built-in `node:test`)
- **Web framework:** Express 4
- **Database:** MongoDB (`mongodb` driver, Atlas Server API v1)
- **Middleware:** CORS
- **CI:** GitHub Actions

## Getting Started

```bash
# clone
git clone https://github.com/nickthelegend/safwah-api.git
cd safwah-api

# install dependencies
npm install

# run the tests (no database required — uses the in-memory store)
npm test

# start the server (reads env vars from .env; defaults to port 4000)
# set MONGODB_URI to connect to MongoDB Atlas, otherwise it runs in-memory
npm start
```

### Endpoints

| Method | Path                 | Description                                   |
| ------ | -------------------- | --------------------------------------------- |
| GET    | `/health`            | Liveness check + active store (`mongodb`/`memory`) |
| GET    | `/rates`             | AED/USDT peg rates with timestamp             |
| GET    | `/transactions`      | 50 most recent transactions, newest-first     |
| POST   | `/transactions`      | Add a transaction (defaults `status`/`ts`)    |
| GET    | `/stats`             | Spend totals, VAT, and category/token breakdown |
| GET    | `/profile/:address`  | Fetch a profile (default if none stored)      |
| PUT    | `/profile/:address`  | Merge-patch and persist a profile             |

## Project Structure

```
.
├── index.js                    # Express app, routes, and storage (Mongo + in-memory)
├── package.json                # Dependencies and scripts
├── test/
│   └── api.test.js             # Integration tests (node:test + fetch)
└── .github/
    └── workflows/ci.yml        # GitHub Actions: install + run tests
```

---

Built by [nickthelegend](https://github.com/nickthelegend) · [nickthelegend.tech](https://nickthelegend.tech)

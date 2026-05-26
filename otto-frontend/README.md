This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Phase 0 Foundations

The app now has the Phase 0 backend foundation from `BUILD_PLAN.md`:

- WorkOS auth with a local-only `OTTO_DEV_AUTH_BYPASS=true` escape hatch.
- Neon Postgres + Drizzle schema and initial migration in `migrations/0000_phase0_foundations.sql`.
- R2 artifact upload presigning through `lib/adapters/storage.ts`.
- Inngest `artifact.uploaded.v1` scaffold at `/api/inngest`.
- Canonical `writeClaim()` projection path with row locking, supersession, evidence links, audit metadata, and idempotency.

Copy `.env.example` to `.env.local` and fill in provider credentials. The app refuses to start in production if `OTTO_DEV_AUTH_BYPASS=true`.

Useful commands:

```bash
npm run db:migrate
npm run lint
npm run test
npm run build
npm run eval:director:smoke
npm run eval:director:container
```

## Director Voice Production Proof

The browser voice path is backed by the Python LiveKit worker in
[`../agents/director`](../agents/director). For a full production proof, configure both
`otto-frontend/.env.local` and `agents/director/.env` with matching `LIVEKIT_AGENT_NAME`,
`LIVEKIT_AGENT_SERVICE_TOKEN`, LiveKit credentials, Anthropic credentials, provider credentials
or `OTTO_USE_LIVEKIT_INFERENCE=true`, and the strict privacy acknowledgement flags.

Then run migrations, start the app, start the worker with
`uv run --no-sync otto-director-agent start --env-file .env`, complete a real `/onboarding/voice`
session, and finish with:

```bash
cd ../agents/director
OTTO_CAPTURE_SESSION_ID=<completed-director-capture-session-id> \
  uv run --no-sync otto-director-session-verify \
    --env-file .env \
    --app-env-file ../../otto-frontend/.env.local \
    --strict-voice-env
```

The verifier must pass without `--allow-incomplete` before the realtime voice implementation is
considered accepted.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

The app uses build-local system font stacks in `app/globals.css`, so production builds do not need network access for remote font downloads.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

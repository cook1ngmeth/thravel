# thravel

Ultra-simple travel expense capture app with one-note input, auto categorization, and Cloudflare sync.

## Run

```bash
npm install
npm run dev
```

## Deploy on Cloudflare

```bash
npm run build
npx wrangler@4 d1 create thravel
```

Update `wrangler.toml` with:
- binding: `DB`
- database_id: `59ba1d26-23e5-4011-b664-3c626f3b241a`

```bash
npx wrangler@4 d1 execute thravel --remote --file migrations/0001_init.sql
npm run build
npm run deploy
```

The first device creates a notebook automatically.  
Use the displayed sync code to join on another device.

## Deployed URL

`https://us.effici.workers.dev`

## GitHub hosting and CI/CD (cook1ngmeth)

This repository should be hosted in the `cook1ngmeth` account as:
`https://github.com/cook1ngmeth/thravel`

Push to `main` to trigger deploy:

1. Set remote:

```bash
git remote add origin https://github.com/cook1ngmeth/thravel.git
```

2. Push:

```bash
git add .
git commit -m "Update thravel"
git push -u origin main
```

3. Add GitHub Action secrets in `cook1ngmeth/thravel`:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Then every push to `main` deploys automatically via GitHub Actions using Wrangler.

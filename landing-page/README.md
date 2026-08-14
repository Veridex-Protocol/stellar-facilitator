# Veridex landing page

A dependency-free static landing page for Veridex Stellar x402 Facilitator and
Federated Bazaar.

## Publish

Deploy this directory as the site root with any static hosting provider:

- **GitHub Pages:** publish the landing-page directory through a Pages workflow,
  or copy its contents into the repository's Pages publishing branch.
- **Cloudflare Pages / Netlify / Vercel:** set the root directory to
  landing-page; no build command is needed.

## Local preview

~~~sh
python3 -m http.server 4173 --directory landing-page
~~~

Then open http://localhost:4173.

## Before publishing

1. Confirm that https://docs.veridex.network/ is publicly accessible without a
   402 challenge for grant reviewers.
2. Replace the inline Veridex mark with the official SVG logo if one becomes
   available.
3. Add the public testnet demo, deployment status page, and published package
   links when those artifacts are available.

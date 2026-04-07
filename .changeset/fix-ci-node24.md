---
"whip-whep-client": patch
---

Fix release CI broken by Node 22.22.2 runner update

Upgraded the publish job to Node 24 and removed the `npm install -g npm@latest`
step. The bundled npm in the Node 22.22.2 GitHub Actions runner image has a
corrupted installation (missing `promise-retry`) that prevents global npm
upgrades, causing publish to fail. Node 24 ships with a working npm that
supports OIDC trusted publishing out of the box.

import { withBrowser, go, shot, info, PLACES } from "./lib.ts";
await withBrowser(async (page) => {
  for (const z of [2.4, 3.3, 4, 6.5]) {
    await go(page, PLACES.A, z);
    await shot(page, `t0-A-${z}`);
    console.log(z, JSON.stringify(await info(page)));
  }
});

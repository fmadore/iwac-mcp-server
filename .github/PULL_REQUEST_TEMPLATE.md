<!-- What changes in behaviour, and why. Link an issue if there is one. -->

## Checks

- [ ] `npm run typecheck && npm run lint && npm run build && npm test` passes in `mcpb/`
- [ ] Tool surface changes are reflected in `manifest.json` and the README tables
- [ ] Every item in new or changed results still carries its canonical `url`
- [ ] `npm run test:tokens` passes; a deliberate footprint change is re-baselined and explained
- [ ] Releasing: `npm run set-version -- X.Y.Z`, a `CHANGELOG.md` entry and `docs/releases/vX.Y.Z.md`

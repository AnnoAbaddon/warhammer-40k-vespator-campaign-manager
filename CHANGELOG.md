# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-30

The first public release. It runs a complete "War on the Vespator Front" map campaign from *500 Worlds: Titus*, from setup to the final scoring and a follow-up campaign. You need the book to play; the app contains no rules text.

### Warmaster

- Setup wizard for 2 or 3 alliances, and a phase cockpit that walks through every step and shows what is still open.
- Operations, battles (1v1 and multiplayer), events, medals and outcomes are calculated by the app. Any value can be overridden with a reason, and every action can be undone.
- Digital or manual dice with a public dice log.
- House rules that are off by default, including the interpretations from the rules FAQ, a mission pool, a hidden score and alternative final scoring.
- Map editor and map generator, custom planet images, campaign templates and a scenario sandbox.
- Decree builder, briefings, gallery, print sheets with QR codes, QR cards for player links, exports, and daily backups with restore.
- Co-Warmaster accounts, club calendar with table collision check, a league with a Hall of Fame, basic Crusade support, a health page and privacy tools.

### Players and viewers

- Personal player links without an account: give orders, move fleets, build infrastructure, report results with photos, confirm or dispute the opponent's report, agree on dates, and subscribe to an iCal feed.
- A read-only view with the interactive map, scores, battle feed, statistics, time-lapse, the Codex chronicle and the rules FAQ.
- A presentation mode for club evenings.

### Notifications

- E-mail (SMTP with TLS), web push, a Discord webhook per campaign and an optional Discord bot with slash commands.
- Deadline reminders and one-time links for confirming a result.

### Languages

- English, German, French, Spanish and Polish. New installations default to English (`NEXT_PUBLIC_DEFAULT_LOCALE`).
- User guide and rules FAQ in English and German, also shown in the app.

### Security

- Central authorization with explicit roles, schema-validated commands and views built from allow-lists.
- Argon2id passwords, hashed sessions with a 90-day limit, a one-time setup token for the first account, login rate limiting, a Content Security Policy with nonces and other security headers.
- Upload checks with pixel and size limits, and hardened Docker settings (read-only file system, dropped capabilities).

### Deployment

- Docker Compose with Caddy for automatic HTTPS; see [DEPLOY.md](DEPLOY.md). Requires Node 24.21 or later (24.x) when run without Docker.

### Notes

- Unofficial fan project, not affiliated with or endorsed by Games Workshop.
- The decorative images were generated with an AI image model and are not covered by the MIT license; see [CREDITS.md](CREDITS.md).

[1.0.0]: https://github.com/AnnoAbaddon/warhammer-40k-vespator-campaign-manager/releases/tag/v1.0.0

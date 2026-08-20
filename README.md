# 🌿 Botany R&D Lab

Mobile-first espresso dial-in logger for **Botany** coffee & tea.

Sessions lock in the machine / grinder / bean; each shot pre-fills from the last so the only thing you touch mid-dial is the **grind**. Built-in shot timer, taste verdicts, recipe starring, offline-first storage, and sync to a shared Google Sheet.

- **Stack**: vanilla HTML/CSS/JS PWA, no build step
- **Data**: localStorage on-device → Google Apps Script webhook → Google Sheet (`Shots` tab, one flat row per shot)
- **Multi-user**: every phone with the sync URL appends to the same sheet; the `barista` column says who
- **Roadmap**: dial-in charts · pull-sync between phones · teapresso/tea module

See [SETUP.md](SETUP.md) for the Sheet hookup and phone install steps.

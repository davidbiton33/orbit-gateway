# Orbit Gateway 2.1.2 — חבילה נקייה להפצה

Orbit Gateway הוא Studio מקומי בעברית, עם API מקומי ו־Chrome עצמאי לכל ספק (ChatGPT, Gemini). הגרסה מבוססת על חבילת 2.1.0 היציבה; שינויי 2.1.2 מתמקדים ב**בידוד התקנה, התחברות ראשונית ותיעוד** — לא בהחלפת מנועי הצ'אט.

**חדש:** כל התקנה טרייה יוצרת `COMPOSE_PROJECT_NAME` אקראי, Volumes עצמאיים, טוקן אישי ופורטים מקומיים. GPT Legacy אינו משתף יותר את פרופיל הדפדפן עם ההתקנה הישנה. יש גם פקודה אחת לבדיקת Clean Install במקביל להתקנה הקיימת.

## בדיקה מאפס במחשב עם Orbit ישן

מתוך התיקייה החדשה של גרסת ההפצה:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-clean-test.ps1
```

הפקודה יוצרת עותק חדש ליד התיקייה, מרימה Docker עם Volumes ריקים ומדפיסה כתובות Studio/noVNC. כל ההוראות להתחברות ולווידוא שההתקנה באמת נקייה נמצאות ב־[INSTALL_HE.md](INSTALL_HE.md).

## התקנה ראשונה למחשב נקי

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-docker.ps1
```

ברירת המחדל היא Studio בכתובת `http://127.0.0.1:4983`. בדיקת CleanTest משתמשת בדרך כלל ב־`5183` כדי לא להתנגש בהתקנה פעילה.

## יכולות ומגבלות

- שיחות ראשונות, שיחות המשך, streaming והשוואה בין ChatGPT / Gemini /.
- פרויקטים מקומיים וגילוי פרויקטים מקוריים ב־ChatGPT דרך מנוע Legacy בלבד.
- GPT Docker ו־GPT Legacy — שני פרופילים עצמאיים לחלוטין; ההחלפה מתבצעת ב־`switch-gpt.ps1`.
- תמונות במנוע GPT Legacy בהתאם לתמיכה בפועל. מנועי Browser הכלליים אינם מבטיחים תמונות.
- מדובר באוטומציית אתר ולא ב־API רשמי; יתכנו שינויים/חסימות של ממשקי הספקים.

מדריכים: [התקנה, התחברות ובדיקות](INSTALL_HE.md) · [תקלות](docs/TROUBLESHOOTING_HE.md) · [יכולות](docs/CAPABILITIES_HE.md) · [אבטחה](SECURITY.md) · [ארכיטקטורה](docs/ARCHITECTURE.md).

**סטטוס QA:** 111/111 בדיקות הרגרסיה ב־Node ומבדקי אריזה סטטיים עברו. אין בידי סביבת Windows עם Docker להפעלת בדיקת Login חיה, ולכן נדרשת הרצת בדיקת CleanTest על מחשב אמיתי לפני טענה ל־Production Verified.


**Orbit 2.1.2:** Dynamic instance ports in Studio; API-only Tailscale Serve via `tailscale-api.ps1`; Clean Test management commands must run from the generated `Orbit-Clean-Test-*` directory. See `INSTALL_HE.md` sections 9–10.


## Orbit 2.3.1 — Agent/API update (2026-10-26)

For up-to-date copy/paste instructions open the Studio API tab, or see skill/SKILL.md.
The OpenAPI reference is docs/openapi.yaml; capabilities are docs/CAPABILITIES_HE.md.
Oracle API: https://your-orbit-host.your-tailnet.ts.net:8443/v1 (Tailscale, Bearer token).
Windows v2.3.1 local API: http://127.0.0.1:5284/v1 (independent token/session).
Supported provider aliases: gpt, gemini, google-ai-mode.
Image POST /v1/images/generations accepts response_format=binary for direct image bytes or
b64_json for JSON, and size=1536x1024 as a 3:2 composition hint (not guaranteed pixels).
Google AI Mode image generation has been live-tested on Oracle with the authenticated Gemini
browser session; images have not yet been live-tested on Windows. Google account quota remains
unknown; GET /v1/usage provides Orbit-local counters only.

# Orbit Gateway 2.3.1 — יכולות בפועל (26.10.2026)

| יכולת | GPT | Gemini | Google AI Mode Lite | Claude |
|---|---|---|---|---|
| צ'אט | כן | כן | כן, אומת ב־Oracle | כן |
| המשך שיחה | תלוי Backend | שמירה וטאב חם | ניסיוני ולא אומת מקצה לקצה | שמירה וטאב חם |
| יצירת תמונה | תלוי ב־Legacy backend | תמונות רסטר, אומת | תמונה בטאב באותו Gemini, אומת ב־Oracle | ציור SVG והמרה ל־PNG |
| עריכת תמונה | תלוי Backend | לא אומת | לא נתמך | לא נתמך |
| בחירת מודל מדויק | דורש אימות | דורש אימות | Auto/Fast לא מאומת בבחירה מדויקת | דורש אימות |

AI Mode ו־Gemini חולקים דפדפן מחובר ותור אחד. אין צורך בחיבור חשבון נפרד ל־AI Mode.

ליצירת תמונה: POST /v1/images/generations עם model google-ai-mode, prompt, response_format=binary או b64_json. ב־binary מוחזר קובץ תמונה, לא JSON. size למשל 1536x1024 הוא רק רמז ליחס 3:2 ולא הבטחה למידות פיקסלים.

GET /v1/usage מחזיר הצלחות דרך Orbit בלבד ב־24 שעות, לא יתרה או מכסה של Google. הבקשות עשויות להיכשל בגלל מגבלות ספק גם אם מונה Orbit נמוך.

Oracle: https://orbit-instance.tail33fc06.ts.net:8443/v1 (דרך Tailscale).
Windows v2.3.1: http://127.0.0.1:5284/v1 (מקומי בלבד).
החשבון/עוגיות והטוקן שונים בין התקנות. AI Mode Images נבדק חי ב־Oracle, אבל לא ב־Windows החדש.

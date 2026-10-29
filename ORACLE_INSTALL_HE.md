# Orbit Gateway 2.1.4 — Oracle ARM64 experiment

**ניסוי עצמאי בלבד. גרסת Windows 2.1.4 נשארת ללא שינוי.** תמונת Docker של GPT Legacy ב-ARM64 והתחברות ChatGPT מול כתובת IP של ענן טרם אומתו בפועל. אין להעתיק Cookies, Volumes או Token ממחשב Windows.

## מה צריך
- Oracle Cloud Ampere A1, Ubuntu 24.04 ARM64 (aarch64), מומלץ לפחות 12GB RAM ושטח דיסק מתאים; זמינות Always Free אינה מובטחת.
- SSH לשרת, Docker Engine עם Compose plugin, Tailscale על השרת ועל המכשיר שמתחבר.
- הפרויקט צריך להישאר על דיסק קבוע. Docker volumes נשמרים בין הפעלות כל עוד לא מסירים אותם.

## 1. התקנת Docker ב-Ubuntu
יש להתקין Docker Engine ו-Compose plugin לפי ההוראות הרשמיות של Docker ל-Ubuntu, כולל הגדרת הרשאות לקבוצת docker לפי הצורך. אל תחשוף את Docker socket לאינטרנט.
בדוק:
```bash
uname -m    # aarch64
sudo docker info
sudo docker compose version
```

## 2. העתקת התיקייה לשרת
חלץ את הארכיון למחשב, והעבר את כל תיקיית `Orbit-Gateway` באמצעות scp או SFTP לשרת, למשל `/opt/orbit-gateway` בבעלות המשתמש שמריץ Docker.
```bash
cd /opt/orbit-gateway
chmod +x install-oracle.sh orbit-oracle.sh tailscale-api-oracle.sh
./install-oracle.sh
./orbit-oracle.sh ps
```
אם Docker מצריך sudo, הפעל את ההתקנה כמשתמש עם הרשאת Docker או בצע הגדרה מתאימה, אך אל תפעיל `chmod 666 /var/run/docker.sock`.

## 3. חיבור בדפדפן ללא חשיפה ציבורית
כל הפורטים של Orbit קשורים ל-127.0.0.1 בשרת. מהמחשב האישי פתח SSH Tunnel (השאר את החלון פתוח):
```powershell
ssh -N -L 4983:127.0.0.1:4983 -L 6080:127.0.0.1:6080 -L 6082:127.0.0.1:6082 USER@SERVER_IP
```
פתח מקומית: GPT Legacy `http://127.0.0.1:6080/vnc.html`, Gemini `http://127.0.0.1:6082/vnc.html`, Studio `http://127.0.0.1:4983`.
Gemini: פתח את ממשק noVNC בפורט 6082, התחבר לחשבון Google בדפדפן המוצג והשאר את ה־Worker פועל. סגירת טאב noVNC בלבד אינה מסיימת את הדפדפן.

## 4. Tailscale לגישה מרחוק ל-API בלבד
התקן Tailscale על Ubuntu לפי ההנחיות הרשמיות, הפעל `sudo tailscale up`, ואשר את המכשיר ב-Tailnet. אל תפתח פורטים 4983/4984/6080–6083 בחומת האש הציבורית.
```bash
./tailscale-api-oracle.sh on
./tailscale-api-oracle.sh status
```
הכתובת הפרטית שתקבל משמשת כ-OpenAI-compatible API ב-`/v1` עם Bearer `GATEWAY_TOKEN` מתוך `.env.docker`. **אל תפרסם את הטוקן.** לביטול: `./tailscale-api-oracle.sh off`.

## 5. בדיקת API
ממכשיר באותו Tailnet:
```bash
curl -H 'Authorization: Bearer YOUR_TOKEN' 'https://YOUR_NODE.YOUR_TAILNET.ts.net:8443/v1/models'
```
לאחר אישור רשימת המודלים יש לבדוק `/v1/chat/completions` בנפרד מול כל ספק; לא הוכחה הצלחה של GPT על ARM64 עד בדיקה חיה.

## 6. תחזוקה
```bash
./orbit-oracle.sh ps
./orbit-oracle.sh logs --tail=80 gpt-legacy
./orbit-oracle.sh restart gateway
```
אל תריץ `docker compose down -v`, ואל תמחוק את ה-Volumes אם ברצונך לשמור התחברויות.

## סיכונים ומגבלות
- Playwright ו-Patchright על ARM64 עשויים להתנהג אחרת מ-x86. במיוחד GPT Legacy עלול להיכשל עוד בשלב ה-build או בהתחברות.
- התחברות לדפדפן מ-IP של מרכז נתונים עלולה להפעיל בדיקות אבטחה נוספות. אל תנסה לעקוף אותן.
- ספקי ה-AI עשויים להגביל אוטומציה של ממשק אינטרנט בהתאם לתנאים שלהם.
- Always Free אינו SLA; Oracle יכולה להגביל משאבים ולהשיב מכונות בהתאם למדיניות שלה.
- noVNC אינו נחשף ב-Tailscale Serve; הוא נגיש רק דרך מנהרת SSH.

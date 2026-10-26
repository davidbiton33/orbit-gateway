# עדכונים חתומים ובטוחים
הפקודות `node bin/gateway.mjs update`, `update --adapters-only`, `update --dry-run`, `rollback` קיימות בגרסה הזו. כדי להשתמש בעדכון **מרחוק** חייבים לפרסם קבצים בשרת HTTPS מאותו Origin, ולהגדיר:

```
UPDATE_MANIFEST_URL=https://trusted-release-host.example/updates/stable/latest.json
UPDATE_PUBLIC_KEY=<base64-of-Ed25519-SPKI-DER>
```

המשתמש מגדיר כתובת אמיתית והמפתח הציבורי של המפיץ. לא קיימת כרגע כתובת שחרור ציבורית שנבחרה/נחתמה בשמך. `gateway update` ללא הגדרות אלה נכשל בבטחה.

`latest.json` צריך להיות JSON בפורמט:

```json
{"version":"2.1.1","files":[{"path":"config/selectors.json","sha256":"64-hex-sha256","url":"https://trusted-release-host.example/updates/stable/selectors.json"}]}
```

הקובץ `latest.json.sig` הוא **חתימת Ed25519 של הבתים המדויקים** של `latest.json`. הקבצים יורדים רק ממקור זהה לכתובת ה־Manifest, נבדקים לפי SHA-256 והגבלות Path, נבדקים תחבירית, ומועתקים עם גיבוי ל־`.backups/`.

תיקיית `.env`, נתוני `data/`, פרופילים ועוגיות של דפדפן ו־`node_modules/` אינם מוחלפים. `rollback` משחזר את הקבצים שהוחלפו בעדכון האחרון; לאחר מכן יש להפעיל את התהליך מחדש.

**מגבלות:** אין כרגע מנגנון עדכוני תלויות/npm ושירות Windows אוטומטי, ואין מנגנון rolling restart של תהליך שכבר רץ. שדרוגים שמשנים גרסאות תלויות צריכים חבילת התקנה מלאה. מיגרציות נתונים לא מופעלות בצורה אוטומטית.

## יצירת גרסה חתומה (במחשב המפתח)

צור מפתחות Ed25519 פעם אחת ושמור את המפתח הפרטי מחוץ לתיקיית הפרויקט:

```bash
openssl genpkey -algorithm ED25519 -out release-private.pem
```

לאחר שינוי selector pack, צור חבילת עדכון חתומה:

```bash
node scripts/create-update-release.mjs https://your-verified-release-host.example/updates/stable /path/to/release-private.pem 2.1.1 config/selectors.json
```

העלה **בדיוק** את תוכן `release-output/2.1.1/` למקום המאובטח שברשותך. הגדר במחשבים המקבלים את `UPDATE_MANIFEST_URL` ואת `UPDATE_PUBLIC_KEY` שהפקודה מדפיסה. לאחר מכן הפקודה `gateway update --adapters-only` תאמת את החתימה ותעדכן אוטומטית. כתובת הדוגמה אינה שירות פעיל.

הסקריפט `scripts/create-update-release.mjs` מיועד למתחזק החבילה, לא למשתמש בהתקנה רגילה; אל תשתמש בו ללא מפתח פרטי תקף ותשתית HTTPS שבשליטתך.

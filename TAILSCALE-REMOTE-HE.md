# גישה מרחוק ל־Orbit באמצעות Tailscale (Windows v2.3.1)

Tailscale Serve מאפשר להגיע לפאנל של Orbit ממחשב או טלפון המחוברים לאותו Tailnet, ב־HTTPS. אין צורך בהפניית פורטים או בדומיין ציבורי. זה אינו Tailscale Funnel — Funnel חושף את השירות לאינטרנט הציבורי, ולכן **לא להשתמש בו**.

## לפני שמתחילים
1. מתקינים Orbit ומריצים פעם אחת את START-WINDOWS-V2.3.1.ps1 ליצירת קובץ .env. משאירים אותו בתיקייה הקבועה.
2. מתקינים Tailscale ב־Windows (PowerShell):
   `winget install --id Tailscale.Tailscale --exact --source winget`
   לחלופין: https://tailscale.com/download/windows
3. פותחים את אפליקציית Tailscale, מתחברים, ומתקינים Tailscale גם בטלפון או במחשב שממנו רוצים לגשת. מחברים לאותו Tailnet. יש להפעיל אישורי HTTPS ב־Tailscale admin אם נדרש.
4. ודאו שהמחשב המארח דולק ושה־Orbit פועל. ודאו שהמכשיר המרוחק מופיע ב־Tailscale.

## התקנה קלה עם הסקריפט המצורף
בתיקייה המחולצת, ב־PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File .\ENABLE-TAILSCALE.ps1
```
הסקריפט מזהה את שם מכשיר ה־Tailscale, מוסיף `ORBIT_REMOTE_STUDIO_HOST` לקובץ .env המקומי ומפעיל Tailscale Serve לפאנל בפורט HTTPS 443.

**חשוב:** סוגרים ומפעילים מחדש את Orbit לאחר הרצת הסקריפט, כדי לקרוא מחדש את .env. הוא אינו מתקין שרת קבוע ואינו משאיר את Orbit רץ כשהמחשב כבוי.

כדי להנגיש גם את **ה־API** מרחוק (לסוכנים/Thunder Client בלבד), מריצים במקום זאת:
```powershell
powershell -ExecutionPolicy Bypass -File .\ENABLE-TAILSCALE.ps1 -ExposeApi
```
האופציה הזאת מוסיפה Serve על HTTPS 8443 ל־API הפנימי (5284). ה־API עדיין דורש Bearer Token אישי מקובץ .env. **אל תשתפו אותו בצ׳אטים או בקוד צד לקוח**.

## פקודות ידניות ושימושיות
```powershell
tailscale status
tailscale serve status
tailscale serve --bg --https=443 http://127.0.0.1:5283
tailscale serve --bg --https=8443 http://127.0.0.1:5284
```
**שים לב:** הפקודות הידניות אינן מעדכנות את ORBIT_REMOTE_STUDIO_HOST; יש להריץ לפחות פעם אחת את ENABLE-TAILSCALE.ps1 (או להגדיר את שם ה־DNS המדויק ב־.env).

כתובת Studio תופיע בפלט של Tailscale Serve, לדוגמה `https://my-pc.my-tailnet.ts.net/`. זו דוגמה בלבד — אין להעתיק אותה מילולית.

בגישה מרחוק ל־API אפשר להשתמש בכתובת `https://<שם-מכשיר-שלכם>.ts.net:8443/v1` עם אותו טוקן מקומי.

## בדיקת חיבור
1. במחשב המארח ודאו ש־`http://127.0.0.1:5283` עובד.
2. במכשיר השני חברו Tailscale ופתחו את כתובת HTTPS שהודפסה.
3. אם Studio מציג 403, ודאו שאכן הפעלתם מחדש את Orbit אחרי שינוי ה־.env.
4. אם מתקבלת שגיאת HTTPS או DNS, בדקו `tailscale status`, הגדרת אישורי HTTPS ב־Tailscale Admin, את חיבור שני המכשירים ואת כללי ACL/Grants.
5. אם מגיעים ל־Studio אך פעולות נכשלות, ודאו שהמחשב המארח מחובר למנועי ה־AI ושלא נדרשת התחברות מחדש.

## ביטול הגישה מרחוק
```powershell
powershell -ExecutionPolicy Bypass -File .\DISABLE-TAILSCALE.ps1
```
לחלופין, כבו רק את הנתיבים שהגדרתם:
```powershell
tailscale serve --https=443 off
tailscale serve --https=8443 off
```
Serve עם `--bg` ממשיך לפעול דרך Tailscale גם אחרי סגירת PowerShell — עד שתכבו אותו. Orbit עצמו עדיין חייב לרוץ.

## אבטחה
**Studio אינו מבקש סיסמה נפרדת.** כל מכשיר שקיבל הרשאה להגיע לנתיב ב־Tailnet עשוי להשתמש בפאנל שלכם ובמכסות חשבונות ה־AI המחוברים! הגבלות גישה דרך Tailscale ACL/Grants והימנעו משיתוף Tailnet עם אנשים לא מהימנים. Tailscale Serve הוא פרטי ל־Tailnet, אבל לא בהכרח פרטי רק לכם אם יש משתמשים נוספים. השתמשו ב־Serve בלבד, לא ב־Funnel. הממשקים המקוריים ממשיכים להאזין ל־127.0.0.1 בלבד.

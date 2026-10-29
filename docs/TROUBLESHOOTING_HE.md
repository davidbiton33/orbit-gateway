# פתרון תקלות — Orbit Gateway

מומלץ לפתוח PowerShell בתוך תיקיית ההתקנה הרלוונטית (או תיקיית CleanTest שהודפסה). הפקודות הבאות אינן מוחקות נתוני חשבון.

| סימפטום | בדיקה / פתרון |
|---|---|
| Docker לא נמצא / Engine not running | התקן או פתח Docker Desktop, הפעל Linux containers וודא שה־Engine פועל. |
| Port is occupied | לבדיקה נקייה במקביל להרצה קיימת השתמש ב־`start-clean-test.ps1` המקצה פורטים אחרים. אל תמחק volumes בגלל קונפליקט פורטים. |
| ה־Studio מציג מסך לבן | פתח את הכתובת שהודפסה בהתקנה, נסה Ctrl+F5, ואז `.\docker.ps1 logs --tail 100 gateway`. |
| Worker אינו משיב או `editor not found` | פתח את מסך noVNC של אותו ספק; בדוק אם נדרש login, אישור חשבון, CAPTCHA או שינוי ממשק. |
| התחברות Gemini/Google AI Mode אינה מצליחה | התחבר ידנית בחלון Chrome שבתוך noVNC. אין להעתיק Cookies ממחשב/משתמש אחר ואין לעקוף בדיקות אבטחה. |
| Chrome profile is in use | המתן לסיום בקשה פתוחה וסגור חלונות Chrome של אותו Worker. אל תמחק פרופיל או Docker volume. |
| GPT Legacy אינו עולה | בחבילה 2.1.1 כל Volume נוצר אוטומטית לכל פרויקט. ודא שהפעלת `switch-gpt.ps1` מאותה תיקייה, ובדוק לוגים של gpt-legacy. אין צורך ליצור volume ידני. |
| פרויקטי ChatGPT חסרים | ודא `GPT_BACKEND=legacy`; ב־GPT Docker חדש אין תמיכה מאומתת בפרויקטים מקוריים. ודא שהתחברת לחשבון הנכון והסרגל באתר הספק פתוח. |
| שיחות ישנות אינן מציגות את כל ההיסטוריה ב־Studio | פתח את השיחה באתר הספק. קישור לפרויקט/שיחה אינו מבטיח שאיבת מלוא היסטוריית ההודעות. |
| בקשה נתקעה / Timeout | **אל תלחץ 'שלח' שוב מיד.** בדוק תחילה באתר הספק אם ההודעה הראשונה נשלחה. |
| מודל/חשיבה מחזירים HTTP 422 | מדובר בבחירה שהמנוע לא מצליח לאמת. נסה ברירת מחדל של הספק ולא מודל/רמה ספציפיים. |
| תמונה מחזירה 501 | במנועי Browser החדשים יצירת/עריכת תמונות אינן מחוברות. נסה Legacy GPT כאשר הוא פעיל ומחובר. |
| noVNC אינו נטען | בדוק `.\docker.ps1 --profile gpt-docker --profile gpt-legacy ps` ופורטי localhost. noVNC הוא מסך מקומי; אין לפרסם ברשת. |

### בדיקת מצב

```powershell
.\docker.ps1 --profile gpt-docker --profile gpt-legacy ps
.\docker.ps1 logs --tail 100 gateway
.\docker.ps1 logs --tail 100 gemini
.\docker.ps1 --profile gpt-docker logs --tail 100 gpt
.\docker.ps1 --profile gpt-legacy logs --tail 100 gpt-legacy
```

להפעלת בדיקת smoke אוטומטית **ששולחת הודעות אמיתיות לחשבונות**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\smoke-docker.ps1
```

אין לשלוח לציבור את `.env.docker`, קובצי cookies או צילומי noVNC. בעת שיתוף לוגים מחק תחילה כל מידע פרטי.

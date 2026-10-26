# דוח QA אריזה — Orbit Gateway 2.1.1

תאריך: 25.10.2026

- ייחוד פרויקט: `COMPOSE_PROJECT_NAME` אקראי, ללא שימוש חוזר אוטומטי בפרויקט קיים.
- GPT Legacy: `legacy-gpt-profile` מנוהל, ללא Volume חיצוני מההתקנה הקודמת.
- `start-clean-test.ps1`: יוצר תיקיית בדיקה עצמאית עם פרויקט ופורטים נפרדים.
- `verify-clean.ps1`: בודק Containers ו־Volumes לפי Docker labels ו־mounts.
- בדיקות Node: **111/111 עברו**, כולל ארבע בדיקות ייעודיות לבידוד התקנה נקייה. התוצאה מאמתת לוגיקת מקור וקונפיגורציה, לא התחברות חיה.
- בדיקות תחביר סטטיות ל־JS, Bash, YAML; בדיקת SHA256 ומניעת צירוף סודות.
- **בדיקת Build/Sign-in חיה ב־Windows + Docker עדיין לא בוצעה בסביבת הבנייה.** נדרשת בדיקת מחשב אמיתי לפני טענה ל־Production Verified.

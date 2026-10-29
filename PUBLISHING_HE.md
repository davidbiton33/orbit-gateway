# Orbit Gateway — הנחיות פרסום למפיץ

**הארכיון הזה מיועד לשיתוף כמו שהוא.** אין לצרף לצדו מתקין Patch או קוד ממאגר ישן. ההתקנה מתחילה מהתיקייה היחידה `Orbit-Gateway/` דרך `INSTALL_HE.md` ו־`setup-docker.ps1`.

## לפני העלאה ל־GitHub Releases או לאתר

1. העלה את `Orbit-Gateway-2.1.2-Release.zip` בלבד, ללא תיקיות הפרופילים או `.env.docker` מהמחשב שבו השתמשת.
2. הוסף תיאור קצר וקישור ל־`INSTALL_HE.md`, וכן למגבלות ב־`docs/CAPABILITIES_HE.md`.
3. ציין במפורש שזהו **Gateway בלתי רשמי המופעל באמצעות דפדפן**, ולא API רשמי של ChatGPT/Google.
4. ציין שפרויקטי ChatGPT מקוריים נתמכים **רק עם GPT Legacy**, ש־Gemini Notebooks אינם נתמכים ושהתקנה חדשה לא מגיעה עם חשבון מחובר.
5. לא בוצע בבניית ההפצה Docker build או בדיקת התחברות מחשבון חדש. אין להציג את 107 בדיקות Node כבדיקת התקנה מלאה.
6. **לפני הגדרת המאגר כ־Open Source**, החליט באיזה רישיון מותר להשתמש בקוד ולהפיצו מחדש. אין רישיון Open Source כלול בארכיון כעת. בדוק שאתה רשאי להפיץ את המקורות ואת שמות המוצרים/המותגים שבהם אתה משתמש.

## הודעת Release מוצעת

**Orbit Gateway v2.1.2 — Self-contained Docker release (Windows)**

חבילה אחת הכוללת Studio בעברית, Gateway API, שלושה Workers מבודדים של ChatGPT / Gemini / ומנוע ChatGPT Legacy אופציונלי. הורדה, חילוץ, הפעלת Docker Desktop והרצת `setup-docker.ps1`. כולל מדריך התקנה מאפס בעברית, דוגמאות API ומסמכי אבטחה ומגבלות.

107 בדיקות Node עברו, אך ההתקנה החיה לא נבדקה מחדש על מכונה נקייה בסביבת האריזה. המערכת מבוססת על ממשקי אתרים ועשויה להצריך התחברות ואימות ידני.


**Orbit 2.1.2:** Dynamic instance ports in Studio; API-only Tailscale Serve via `tailscale-api.ps1`; Clean Test management commands must run from the generated `Orbit-Clean-Test-*` directory. See `INSTALL_HE.md` sections 9–10.

# إصدار نسخة جديدة — SaberMarko POS

## ما الذي يحدث تلقائيًا
عند دفع tag بالشكل `vX.Y.Z` (مطابق لـ `version` في `package.json`) يعمل `.github/workflows/release.yml` على جهاز
Windows حقيقي من GitHub ويقوم بالآتي:

1. **بوابة الإصدار** (`tools/release/check-release.mjs`): رقم الإصدار = الـtag، يوجد قسم له في `CHANGELOG.md`،
   البرنامج **لا يحتوي مفتاح الترخيص التجريبي (dev)**، ولا توجد أي مفاتيح أو كلمات سر في المستودع.
2. فحص الأنواع + اختبارات الوحدات على Windows.
3. بناء المُثبّت `SaberMarko-POS-Setup-X.Y.Z.exe` (NSIS، **غير موقّع**).
4. حساب `SHA256SUMS.txt`.
5. اختبار تثبيت صامت ثم إزالة صامتة للتأكد أن المُثبّت يعمل (هذا ليس اختبارًا لتشغيل واجهة البرنامج).
6. نشر GitHub Release بالملفين وملاحظات الإصدار (`docs/release-notes/vX.Y.Z.md` أو قسم CHANGELOG).

لا يستخدم أي من الـworkflows أي secret غير `GITHUB_TOKEN` الافتراضي، ولا يرفع أي مفتاح خاص أو كلمة سر أو شهادة.
التشغيل اليدوي (Run workflow) يبني المُثبّت كـartifact للتجربة فقط بدون نشر.

## الخطوات (مرة واحدة قبل أول إصدار تجاري)
1. على **جهازك أنت** (وليس على GitHub أو أي خادم):
   ```bash
   npm run license:keygen                 # المفتاح الخاص يُحفظ في ~/.sabermarko-vendor-keys/ خارج المستودع
   # أو بتشفير إضافي بكلمة مرور:
   read -s PASS && SBM_KEY_PASSPHRASE="$PASS" npm run license:keygen   # تكتب كلمة المرور ولا تظهر ولا تُحفظ
   ```
   الأداة **ترفض** حفظ المفتاح الخاص داخل أي مستودع git، وتكتب المفتاح العام فقط في
   `src/main/license/public-key.ts` وتطبع بصمته (fingerprint).
2. احتفظ بنسختين من المفتاح الخاص offline (فلاشة مشفّرة + مكان آخر). من يملكه يستطيع إصدار تراخيص.
3. `git add src/main/license/public-key.ts && git commit` — هذا الملف آمن (مفتاح عام).
   خطاف `pre-commit` (يُفعَّل تلقائيًا مع `npm install`) يمنع أي commit يحتوي مفتاحًا خاصًا أو ملف ‎.pem/.pfx أو كلمة سر.

## كل إصدار
```bash
# 1) حدّث الرقم والتغييرات
npm version 1.0.1 --no-git-tag-version
#    أضف "## [1.0.1]" في CHANGELOG.md (واختياريًا docs/release-notes/v1.0.1.md)
# 2) تحقق محليًا
npm run release:check -- v1.0.1 && npm test
# 3) ادفع ثم أنشئ الـtag
git commit -am "Release 1.0.1" && git push
git tag v1.0.1 && git push origin v1.0.1
```

## إصدار ترخيص لعميل
```bash
npm run license:issue -- --machine 9F2C1-0B7A4-33D10-AA0F2 --customer "سوبر ماركت البركة" --type permanent --edition standard
npm run license:issue -- --machine 9F2C1-... --customer "..." --type temporary --days 365 --max-users 8
npm run license:verify -- SBM1.xxxx.yyyy --machine 9F2C1-0B7A4-33D10-AA0F2
```
`license:issue` يتحقق من أن المفتاح الجديد يعمل مع المفتاح العام المبني في البرنامج قبل طباعته.
الباقات: `basic` = 2 مستخدمين نشطين، `standard` = 5، `professional` = 15، و`--max-users` يتجاوز الباقة.
مفاتيح بدون باقة (مثل مفاتيح الإصدارات الأقدم) تعمل كما هي بحد 10 مستخدمين.

## التوقيع الرقمي — بأمانة
- المُثبّت **غير موقّع** لأنه لا توجد شهادة Code Signing. GitHub Releases **لا** يوقّع الملفات.
- النتيجة: قد يظهر تحذير Windows SmartScreen. البصمة SHA256 المنشورة تثبت أن الملف لم يتغير، لكنها لا تُغني عن التوقيع.
- عند الحصول على شهادة: أضف `CSC_LINK` و`CSC_KEY_PASSWORD` كـ **GitHub Secrets** (وليس في الملفات)، وغيّر
  `CSC_IDENTITY_AUTO_DISCOVERY` في release.yml.

## ما تم التحقق منه وما لم يتم
| البند | الحالة |
|---|---|
| بناء مُثبّت Windows (NSIS x64) | تم (محليًا عبر wine، وفي release.yml على Windows runner) |
| تثبيت/إزالة صامتة | تم آليًا |
| تشغيل البرنامج فعليًا على Windows 10/11، الطباعة الحرارية، القارئ | **يحتاج جهاز Windows حقيقي** — لم يُختبر |

قائمة الاختبار اليدوي على Windows قبل البيع: تثبيت جديد ← إعداد المحل ← منتج ← وردية ← بيع وطباعة على الطابعة الحرارية
← نسخة احتياطية على فلاشة ← إغلاق وإعادة تشغيل ← تحديث فوق الإصدار السابق ← إزالة (يجب أن تبقى البيانات في
`%APPDATA%\SaberMarko POS`) ← تثبيت على جهاز آخر واستعادة النسخة من أول شاشة.

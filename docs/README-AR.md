# RustDesk Admin — v1.0.0

<p align="center">
  [<a href="../README.md">English</a>] | [<a href="README-RU.md">Русский</a>] | [<a href="README-ZH.md">中文</a>]<br>
</p>

مستودع واحد لنشر **خادم RustDesk** معزول بالحاويات بالكامل مع لوحة إدارة ويب:
خادم المعرفات (ID) + خادم الترحيل (relay) + لوحة الإدارة + حالة حضور الأجهزة
الحية + شهادات Let's Encrypt تلقائية — كل ذلك في مشروع Docker Compose واحد.

> كُتب هذا المشروع بالكامل بواسطة مساعد ذكاء اصطناعي للبرمجة — لا يوجد أي
> سطر كود مكتوب يدويًا في هذا المستودع.
لا يحتاج مضيف التشغيل سوى **Docker** — لا وحدات systemd، ولا certbot على المضيف،
ولا nginx على المضيف.

كل شيء يتحمّل إعادة التشغيل: `docker compose restart` أو إعادة تشغيل الخادم أو
إعادة تشغيل `./setup.sh` لا تُفقد أي بيانات أو إعدادات.

```
RustDeskAdmin/
├── docker-compose.yml         # 8 خدمات على شبكة واحدة
├── docker-compose.dev.yml     # توسعة اختيارية: air hot-reload + خادم vite
├── setup.sh                   # تهيئة أول تشغيل (idempotent)
├── .env.example               # قالب؛ انسخه إلى .env
├── Makefile                   # أوامر مساعدة (dev/build/logs/shell/test …)
├── backend/                   # واجهة Go API للإدارة (صورة prod صغيرة)
├── frontend/                  # واجهة React للإدارة (nginx ثابت / SPA)
├── nginx/nginx.conf.template  # ${DOMAIN} + ACME webroot + إنهاء WSS
├── presence/Dockerfile        # مقياس الحضور (docker.sock + nsenter)
├── scripts/presence.sh        # لقطة الاتصالات الحية (نامى فضاءات hbbs/hbbr)
├── data/                      # البيانات الحية - يُنشئها setup.sh:
│   ├── hbbs/                  #   مفتاح hbbs/hbbr (id_ed25519) + قاعدة أجهزة sqlite
│   ├── postgres/              #   دليل بيانات Postgres (bind mount)
│   ├── screenshots/           #   مرفوعات صفحة التحميل (SCREENSHOTS_DIR)
│   └── certbot/etc/           #   live/archive/renewal لـ Let's Encrypt (+ www/)
└── status/                    # presence.json (يكتبه حاوية presence)
```

`data/` و `status/` مستبعدان من git/tar ولا يُضمّنان أبدًا في الأرشيف.

## لقطات الشاشة

| الوضع الفاتح                                                  | الوضع الداكن                                                 |
|---------------------------------------------------------------|--------------------------------------------------------------|
| ![لوحة التحكم (فاتح)](screenshots/Dashboard_white.png)        | ![لوحة التحكم (داكن)](screenshots/Dashboard_dark.png)        |

---

## فهرس المحتويات

- [الوظائف](#الوظائف)
- [البنية / الخدمات](#البنية--الخدمات)
- [المتطلبات](#المتطلبات)
- [التثبيت من الصفر](#التثبيت-من-الصفر)
- [المنافذ وإعدادات `.env`](#المنافذ-وإعدادات-env)
- [الشهادات (Let's Encrypt)](#الشهاداتlets-encrypt)
- [معلومات الخادم](#معلومات-الخادم)
- [عميل RustDesk للويب](#عميل-rustdesk-للويب)
- [التحكم عن بُعد من المتصفح](#التحكم-عن-بُعد-من-المتصفح)
- [صفحة التحميل العامة](#صفحة-التحميل-العامة)
- [رمز إعداد العميل](#رمز-إعداد-العميل)
- [وضع التطوير (dev overlay)](#وضع-التطويرdev-overlay)
- [مصادر التحميل والمرايا (Block C)](#مصادر-التحميل-والمرايا-block-c)
- [تنظيف Docker بعد البناء (Block D)](#تنظيف-docker-بعد-البناء-block-d)
- [النسخ الاحتياطي والترحيل](#النسخ-الاحتياطي-والترحيل)
- [التحديث](#التحديث)
- [استكشاف الأخطاء](#استكشاف-الأخطاء)
- [API (مرجع)](#api-مرجع)

---

## الوظائف

- **لوحة إدارة الويب** (React SPA + Go API):
  - لوحة المعلومات — ملخص حالة الخادم، الحضور الحي.
  - الأجهزة — قائمة الأجهزة المسجلة (`GET /api/devices`)، أعمدة PeerInfo
    (المضيف/المستخدم/النظام/الإصدار/الشاشات)، بحث، تثبيت/اسم مستعار، كلمات
    مرور محفوظة مشفّرة، عرض التفاصيل، الحذف.
  - الإعدادات — أقسام قابلة للطي (الحالة تُحفظ في المتصفح)، إعدادات اللوحة
    (مأخوذة من `.env` ثم تملكها قاعدة البيانات)؛ القيم الافتراضية لعميل الويب
    ورسائل النظام للدردشة واسم العرض تُضبط هنا.
  - تسجيل الدخول = JWT access + refresh مع جلسات مخزّنة على الخادم؛ تُدار الجلسات وتُنظَّف عند انتهاء رمز refresh؛ وتغيير بيانات admin.
- **الحضور الحي** (حاوية `presence`):
  - يقرأ اتصالات hbbs/hbbr الحقيقية مباشرةً من نطاقاتها (فضاءاتها) في الشبكة
    (nsenter + `ss` + docker.sock)؛
  - يكتب `status/presence.json` بعناوين IP للأقران النشطين وحالة منافذ الاستماع
    وربط الأقران بالعناوين؛
  - الحالة تُجمَّع أيضًا في الخلفية وتُعرض عبر `/api/status`.
- **خادم RustDesk**: hbbs (ID) + hbbr (relay) من الصورة الرسمية
  `rustdesk/rustdesk-server:1.1.16`؛ المفتاح وقاعدة الأجهزة في `data/hbbs/`.
- **TLS بدون إعدادات**: Let's Encrypt مُدار ذاتيًا (webroot)، تجديد تلقائي كل 12 ساعة،
  بالإضافة إلى إنهاء WSS عبر nginx على المنفذين 21118/21119 لتقنية RustDesk TCP-mux.
- **Server Info مع المصادر**: يقرأ العملاء/عميل الويب العنوان/المنافذ/المفتاح من
  `GET /api/server-info` — وكل حقل يوضح مصدره (env/setting/stack).
- **CORS لعميل RustDesk للويب**: الترويسات تسمح لعميل الويب rustdesk.com.

---

## البنية / الخدمات

| الخدمة  | الصورة                                       | الغرض                                                   |
|---------|-----------------------------------------------|---------------------------------------------------------|
| postgres | postgres:16-alpine                           | قاعدة بيانات اللوحة (`./data/postgres`)، ترحيلات عند الإقلاع |
| backend  | مبنية (`backend/Dockerfile`، مرحلة prod)     | REST API + WebSocket + قارئ الحضور                      |
| frontend | مبنية (`frontend/Dockerfile`، مرحلة prod)    | واجهة الإدارة (nginx ثابت / SPA)                        |
| nginx    | nginx:alpine                                  | HTTPS للوحة، ACME webroot، WSS 21118/21119              |
| hbbs     | rustdesk/rustdesk-server:1.1.16              | خادم ID (`-r ${DOMAIN}:21117`)                          |
| hbbr     | rustdesk/rustdesk-server:1.1.16              | خادم الترحيل                                             |
| presence | مبنية (`presence/Dockerfile`)                 | استطلاع الفضاءات ← `status/presence.json`               |
| certbot  | certbot/certbot                               | الإصدار عند أول تشغيل، التجديد كل 12 ساعة                |

كل الحاويات تستخدم `restart: unless-stopped` — تعود تلقائيًا بعد إعادة تشغيل نظام
التشغيل أو Docker.

---

## المتطلبات

- Docker Engine + Docker Compose v2:
  ```
  apt update && apt install -y docker.io docker-compose-v2
  systemctl enable --now docker
  ```
- نطاق عام يشير (سجل DNS A) إلى هذا الخادم.
- منافذ TCP خالية: `80`، `443`، `21115`–`21119` (بالإضافة إلى UDP `21116` و`21117`)؛
  جميعها قابلة لإعادة التعيين عبر `.env` (انظر أدناه).
- افتراضيًا صور backend/frontend صغيرة (نحو 50 MB / بضعة MB).
  توسعة dev تحتاج بضعة GB قرصًا ونحو 2 GB ذاكرة.
- توصية للأجهزة الرخيصة (مثل 1.9G ذاكرة / 8.7G قرص): أضف ملف swap قبل البناء
  (البناء يستهلك الذاكرة) وراقب مساحة القرص.

مثال جدار حماية (ufw):

```
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 21115/tcp
ufw allow 21116/tcp
ufw allow 21116/udp
ufw allow 21117/tcp
ufw allow 21117/udp
ufw allow 21118/tcp
ufw allow 21119/tcp
ufw enable
```

---

## التثبيت من الصفر

```
git clone https://github.com/pierce1stg/RustDeskAdmin.git
cd RustDeskAdmin

cp .env.example .env
# عدّل .env: DOMAIN=<اسم مضيفك>, LETSENCRYPT_EMAIL=<بريدك>
./setup.sh
```

قبل التشغيل، تأكد أن `DOMAIN` يُحل (سجل A) إلى الـ IP العام لهذا الخادم وأن المنفذ 80
يمكن الوصول إليه من الإنترنت — فتحدي HTTP-01 من Let's Encrypt يُقدَّم عبره بواسطة
nginx. إذا ظهر تحذير **«placeholder cert»** عند أول تشغيل وبدا كل شيء آخر سليمًا،
فأصلح DNS/جدار الحماية ثم أعد تشغيل `./setup.sh` — فهو idempotent ويعيد محاولة
الإصدار بنفس النطاق.

### توليد الأسرار يدويًا (اختياري)

يولّد `setup.sh` الأسرار تلقائيًا عندما تكون فارغة/`changeme` (انظر Block A أدناه).
لاختيارها بنفسك:

```
POSTGRES_PASSWORD=$(openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 32)
JWT_REFRESH_SECRET=$(openssl rand -base64 32)
DEVICE_SECRET=$(openssl rand -base64 32)
```

...وضع القيم في `.env`. يمكنك أيضًا إبقاء `changeme` — فالسكربت سيستبدلها بقيم
عشوائية عند أول تشغيل. يفشل `setup.sh` إذا كان `DOMAIN` فارغًا أو بقي العنصر
النائب `app.example.com` — ضع اسم host حقيقيًا.

سينفّذ `setup.sh` (idempotent):

1. يولّد `POSTGRES_PASSWORD` و`JWT_SECRET` و`JWT_REFRESH_SECRET` إن كانت فارغة/`changeme`؛
2. ينشئ `data/` و`status/`؛
3. يضع شهادة placeholder موقّعة ذاتيًا في `data/certbot/etc/live/<DOMAIN>` ليعمل
   nginx دائمًا مع TLS؛
4. `docker compose up -d --build`؛
5. ينتظر إنشاء hbbs لملف `data/hbbs/db_v2.sqlite3`؛
6. يصدر شهادة Let's Encrypt حقيقية عبر HTTP-01 webroot على المنفذ 80
   (`--cert-name <DOMAIN>`) ويعيد تحميل nginx فورًا؛
7. يطبع ملخصًا.

أعد تشغيل `./setup.sh` في أي وقت لإعادة البناء أو إنشاء الحاويات أو إصدار الشهادة.

### أول تسجيل دخول

بيانات admin مخزّنة من Block B في `.env` (`ADMIN_USERNAME`/`ADMIN_PASSWORD`،
الافتراضي `admin`/`admin`). **غيّر كلمة المرور فورًا** من اللوحة
(الإعدادات ← بيانات admin). يجب ألا تقل كلمة المرور عن 8 أحرف (يُتحقق منها
الخادم الخلفي).

---

## المنافذ وإعدادات `.env`

### Block A (مطلوب / أسرار)

| المتغير                 | الوصف                                                  |
|-------------------------|--------------------------------------------------------|
| `DOMAIN`                | الاسم المضيف العام (DNS A → هذا المضيف)                |
| `LETSENCRYPT_EMAIL`     | بريد إشعارات LE (التجديد)                              |
| `POSTGRES_PASSWORD`     | كلمة مرور Postgres (تُولَّد تلقائيًا إذا كانت `changeme`) |
| `JWT_SECRET`            | سر توقيع JWT للـ API (يُولَّد تلقائيًا)                |
| `JWT_REFRESH_SECRET`    | سر رمز refresh (يُولَّد تلقائيًا)                      |

### Block B (بذور لمرة واحدة — اللوحة تملك الإعدادات لاحقًا)

`ADMIN_USERNAME` و`ADMIN_PASSWORD` و`STATUS_REFRESH_INTERVAL` (30s)
و`SERVER_DISPLAY_ADDRESS` (تجاوز اختياري) و`RUSTDESK_PUBLIC_KEY` (اختياري؛ في ستاك
جديد يولّد hbbs المفتاح في `data/hbbs`) و`RUSTDESK_ID_PORT` و`RUSTDESK_RELAY_PORT`
و`RUSTDESK_WS_PORT` و`ACCESS_TOKEN_TTL_MINUTES` (60) و`REFRESH_TOKEN_TTL_DAYS` (7)
و`RUSTDESK_SERVER_VERSION` (1.1.16، تثبيت compose لـ hbbs/hbbr) و`ALLOW_SERVER_UPDATE`
(true، يفعّل بطاقة Server updates في اللوحة) و`ALLOW_PANEL_UPDATE`
(true، يفعّل بطاقة Panel update في اللوحة — الفحص والتحديث فقط بضغطة زر؛ لا يوجد تحديث ذاتي تلقائي).

### القيم الافتراضية لعميل الويب (بذور لمرة واحدة، ثم: الإعدادات ← عميل الويب)

| المتغير | الافتراضي | المسموح | المعنى |
|---|---|---|---|
| `WEB_CLIENT_QUALITY` | 3 | 0 (تلقائي)، 2، 3، 4 | جودة الصورة الابتدائية |
| `WEB_CLIENT_FPS` | 30 | 1..240 | معدل الإطارات الابتدائي |
| `WEB_CLIENT_CODEC` | auto | auto، vp8، vp9، av1 | تفضيل الترميز الابتدائي |
| `WEB_CLIENT_RENDER_SCALE` | auto | auto، original، 144p..1440p | سقف التفاصيل |
| `WEB_CLIENT_CURSOR` | false | true/false | تراكب مؤشر المضيف |
| `WEB_CLIENT_INPUT_MODE` | auto | auto، touch، pointer | وضع الإدخال (`auto` = حسب الجهاز) |
| `WEB_CLIENT_NAME` | Web Browser | 1..64 حرفًا | الاسم الذي تراه المضيفات |
| `WEB_CLIENT_CHAT_GREETING` | Hello! How can I help you? | ≤2000 حرف، فارغ = صمت | ترحيب تلقائي عند أول فتح للدردشة |
| `WEB_CLIENT_CHAT_GREETING_ENABLED` | true | true/false | مفتاح الترحيب |
| `WEB_CLIENT_CHAT_CLOSE` | The operator has closed the chat. | ≤2000 حرف، فارغ = صمت | إشعار إغلاق الدردشة |
| `WEB_CLIENT_CHAT_CLOSE_ENABLED` | true | true/false | مفتاح الإشعار |

### عمر الجلسة (JWT TTL)

رمز access يحرس كل استدعاء API؛ رمز refresh يُبقي جلسة المتصفح حيّة ويُدار مرة واحدة
عند كل تجديد. كلاهما قابل للضبط — يُزرع من `.env` في ستاك جديد ويُعدَّل في أي وقت من
**الإعدادات ← الجلسة**:

| المتغير                   | الافتراضي | النطاق  | المعنى                                   |
|---------------------------|-----------|---------|------------------------------------------|
| `ACCESS_TOKEN_TTL_MINUTES`| 60        | 5..10080 | صلاحية رمز access (بالدقائق)             |
| `REFRESH_TOKEN_TTL_DAYS`  | 7         | 1..365   | مدة بقاء الجلسة الخاملة (بالأيام)        |

الجلسات مخزّنة في الخادم داخل `auth_sessions` (postgres)، لذا يبقى تسجيل الدخول
النشط بعد إعادة تشغيل الخادم وإعادة نشر الستاك. تغيير TTL يؤثر فقط على الرموز
المصدرة بعد التغيير؛ الرموز الحالية تنتهي طبيعيًا، ثم تطلب اللوحة تسجيل الدخول مجددًا.

### تعيين منافذ المضيف (الكل اختياري، المبينة هي الافتراضي)

| المتغير          | الافتراضي | المعنى                                         |
|------------------|-----------|------------------------------------------------|
| `HTTP_PORT`      | 80        | ACME webroot / HTTP→HTTPS                      |
| `HTTPS_PORT`     | 443       | TLS للوحة                                      |
| `NAT_PORT`       | 21115     | hbbs (NAT/نبض القلب)                           |
| `ID_PORT`        | 21116     | خادم ID hbbs (tcp+udp)                         |
| `RELAY_PORT`     | 21117     | ترحيل hbbr (tcp+udp)                           |
| `WSS_ID_PORT`    | 21118     | WSS → hbbs (إنهاء TLS عبر nginx)               |
| `WSS_RELAY_PORT` | 21119     | WSS → hbbr (إنهاء TLS عبر nginx)               |
| `API_PORT`       | 8080      | منفذ الخلفية، loopback فقط (`127.0.0.1`، التشخيص عبر ssh) |

منافذ الاستماع داخل الحاويات ثابتة؛ فقط تعيين مضيف المنفذ قابل للمعاملات.
مثال: إن شغّل خادم آخر منفذ المضيف 443، فعيّن `HTTPS_PORT=8443`.

---

## الشهادات (Let's Encrypt)

- التهيئة: placeholder موقّع ذاتيًا → يبدأ الستاك دائمًا مع TLS.
- الإصدار: HTTP-01 webroot. يتطلب منفذ المضيف `80` (انظر `HTTP_PORT`) وتدفق TCP/UDP
  واردًا. إن كان `HTTP_PORT != 80` فسيُتخطى الإصدار التلقائي (اجعله 80، أو شغّل
  certbot يدويًا).
- التجديد: حاوية `certbot` تشغّل `certbot renew --quiet` كل 12 ساعة؛ nginx يعيد تحميل
  نفسه كل 6 ساعات لالتقاط الشهادات الجديدة (لا docker CLI داخل certbot).

علامة `--cert-name <DOMAIN>` تجعل certbot يكتب إلى
`data/certbot/etc/live/<DOMAIN>` وهو ما يقرأه قالب nginx.

---

## معلومات الخادم

يعيد `GET /api/server-info` كل حقل مع **مصدره**:

| الحقل          | المصادر (الأولوية)                                           |
|----------------|--------------------------------------------------------------|
| address        | تجاوز يدوي ← متغير `DOMAIN` ← Host في الطلب                  |
| relay address  | تجاوز يدوي ← متغير `RELAY_ADDRESS` ← نفس address            |
| api server     | تجاوز يدوي ← متغير `RUSTDESK_API_SERVER` ← فارغ (غير مستخدم)|
| ports          | تجاوز يدوي ← بذور البيئة ← افتراضيات الستاك                  |
| public key     | تجاوز يدوي ← `data/hbbs/id_ed25519.pub`                      |

يستخدم العملاء/عميل الويب هذه القيم؛ في ستاك جديد ينشئ hbbs المفتاح عند أول تشغيل
ويلتقطه الخادم الخلفي تلقائيًا (مصدر `rustdesk-server`).

---

## عميل RustDesk للويب

للاتصال عبر عميل الويب (https://rustdesk.com/web)، أشر إلى Server Info في اللوحة
عند `DOMAIN` والمنافذ، واستخدم المفتاح من اللوحة. ترويسات CORS في nginx تسمح بأصول
`rustdesk.com`/`web.rustdesk.com`.

---

## التحكم عن بُعد من المتصفح

تدير اللوحة نفسها جلسات بعيدة في المتصفح (`control/:id`) — لا حاجة لعميل سطح مكتب:

- **الترميزات**: فك VP8 / VP9 / AV1 برمجيًا فقط (WebCodecs)؛ ترميزات العتاد مُستبعدة
  عمدًا. الوضع التلقائي يبدأ بالمُجرَّب (`last-good` وإلا VP9)؛ الاختيار اليدوي حرفي،
  مع مهلة قبل إعلان عدم امتثال المضيف وشريط “عودة للتلقائي”.
- **سلّم الجودة التلقائي** مع قاع عميق (حتى 1/10 عند تكدّس الطابور)، إعداد Turbo
  (Low/60/الأرخص + استعادة بنقرة)، سقوف render-scale.
- **سجل الجلسة v2**: مستويات وفئات وبحث بتمييز وبوابة تسجيل وعلامات انقطاع
  وطيّ بعدّاد وتدقيق `ui:` كامل.
- **دردشة الجلسة**: نافذة عائمة + فقاعة قابلة للإرساء (المواضع تُحفظ)، شارة غير
  المقروء، منتقي إيموجي، ترحيب/إشعار إغلاق قابلان للضبط، اسم عرض العميل، وسجل
  للجلسة فقط. نص فقط — لا نقل ملفات ولا إغلاق عن بُعد في البروتوكول.
- حافظة بالاتجاهين واختصارات وتبديل شاشات وتكبير ولوحة لمس وتراكب مؤشر المضيف.

مصفوفة القبول ومرجع سطور السجل: `acceptance-AR.md` (RU/EN/ZH بجواره)، والقائمة
البشرية: `manual-checklist.md`.

---

## صفحة التحميل العامة

تقدّم اللوحة صفحة عامة لتحميل العملاء (`/download` تُضبط من `/download-config`):
نصوص لكل لغة وأقسام منصات بأزرار تحميل ورفع لقطات (تُخزَّن في `SCREENSHOTS_DIR`
أي `./data/screenshots` افتراضيًا — لا تخلطها مع `docs/screenshots/` فتلك صور هذا الملف).

---

## رمز إعداد العميل

تعرض لوحة المعلومات **رمز إعداد العميل** الجاهز للتوزيع مبنيًّا من Server Info
الحالية (`GET /api/server-info/connect-code`). انسخ **Config code** إلى عميل
RustDesk والصقه في **الإعدادات ← الشبكة ← Import** — يطبّق العميل خادم ID/الترحيل
وخادم API الاختياري والمفتاح تلقائيًا:

| الصيغة        | مثال |
|---------------|------|
| Config code | `=0nI9smcPhWR0YVcz1mekllS3JDbVNm...` — الترميز base64url المعكوس (مع الحشو) للـ JSON `{"host","relay","api","key"}` |
| Raw JSON | `{"host":"<your-domain>","relay":"<your-domain>","api":"","key":"<your-public-key>"}` — يقبله Import أيضًا |
| البديل | `host=<your-domain>,key=<your-public-key>,relay=<your-domain>` |

الرمز **غير موقع**: محلل العميل (`ServerConfig.decode` في `flutter/lib/common.dart`)
يجرب الـ JSON الخام أولًا ثم الصيغة base64url المعكوسة — كلتاهما يولدهما الخادم
الخلفي. الصيغة الموقعة التي تستخدمها لوحة الويب المستضافة لا يمكن إنتاجها هنا
(مفتاح توقيعها خاص). تُدرج منافذ ID/الترحيل غير الافتراضية بصيغة `host:port` في
الحقل المناسب. قد يكون المضيف نطاقًا أو عنوان IPv4 أو عنوان IPv6 بين أقواس؛ قيمة
الخادم API إن ضُبطت يجب أن تكون URL كامل `http(s)://`.

---

## وضع التطوير (dev overlay)

إعادة تحميل سريعة مع air + خادم Vite dev (صور أكبر، يحتاج قرصًا/ذاكرة):

```
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

خادم تطوير الواجهة يستمع على منفذ المضيف `5173`. الخلفية تعمل تحت `air` وتُعاد
بناؤها على تغيّر الملفات.

---

## مصادر التحميل والمرايا (Block C)

كل التنزيلات الخارجية للستاك تمر عبر مصادر محددة قليلة يمكن إعادة توجيهها يدويًا
من `.env` (انظر قسم `Block C` في `.env.example`). أعد التطبيق بعد التغيير: أعد
تشغيل `./setup.sh` (أو `docker compose build`).

| الحركة                              | قابلة للتجاوز عبر          | المصدر الافتراضي                                        |
|--------------------------------------|----------------------------|--------------------------------------------------------|
| صور Docker (وقت التشغيل + `FROM` الأساسية) | `DOCKER_REGISTRY_PREFIX`  | Docker Hub (مثل `postgres:16-alpine`)            |
| وحدات Go + أداة `air`                | `GOPROXY`                  | `https://proxy.golang.org,direct`                     |
| حزم npm (الواجهة)                    | `NPM_REGISTRY`             | `https://registry.npmjs.org`                          |
| حزم Alpine apk                       | `APK_MIRROR`               | `https://dl-cdn.alpinelinux.org/alpine`               |

أمثلة:

```
# اسحب كل شيء عبر سجل خاص
DOCKER_REGISTRY_PREFIX=registry.example.com/

# استخدم مرآة وكيل وحدات Go (الصين / الشبكات المقيدة)
GOPROXY=https://goproxy.cn,direct

# استخدم مرآة سجل npm
NPM_REGISTRY=https://registry.npmmirror.com

# استخدم مرآة Alpine (تبقي مسارات /v3.xx، يُستبدل المضيف فقط)
APK_MIRROR=https://mirror.example.com/alpine
```

ملاحظات:
- أبقِ المتغيرات فارغة للاحتفاظ بالمصادر الرسمية.
- `DOCKER_REGISTRY_PREFIX` يُضاف قبل كل إشارة صورة (سواء `image:` في compose أو
  `FROM` في Dockerfiles)، بما فيها صور البناء/الأساس.
- `APK_MIRROR` يستبدل المضيف
  `https://dl-cdn.alpinelinux.org/alpine` فقط داخل الصور المُبنية، فتبقى مسارات
  `/v3.xx/{main,community}` مطابقة دائمًا لنسخة Alpine الخاصة بالصورة الأساس.
- التحويل الاحتياطي يدوي: لا ينتقل Docker تلقائيًا إلى مرآة. اضبط القيم مسبقًا على
  المضيفين ذوي الشبكة المقيدة.

---

## تنظيف Docker بعد البناء (Block D)

يُطلق `./setup.sh` تنظيف موارد Docker غير المستخدمة في النهاية (انظر `Block D` في
`.env.example`) حتى لا تملأ البنيات القرص — مهم في VPS صغيرة.

| `DOCKER_PRUNE_ON_BUILD` | ما يُحذف                                                   |
|-------------------------|-----------------------------------------------------------|
| `all` (الافتراضي)       | كل صورة لا يستخدمها حاوية قيد التشغيل (صور البناء الأساسية مثل `golang`/`node`/`python` alpine تُسحب مجددًا في البناء التالي)، حاويات one-shot متوقفة، شبكات/وحدات تخزين غير مستخدمة |
| `safe`                  | الصور المعلقة فقط + ذاكرة البناء                          |
| `none`                  | لا تنظيف                                                  |

لا يُمسّ أبدًا: الصور التي يستخدمها الستاك القيد التشغيل فعليًا
(`rustdesk-stack-*` و`postgres` و`nginx` و`certbot` و`rustdesk-server`) ومجلد
`data/`. إن أزال `all` صور البناء الأساسية، سيعيد `./setup.sh` التالي تنزيلها
(نحو 500 MB). على قرص ضيق، تشغيل `docker image prune -a -f` قبل إعادة تشغيل
`./setup.sh` يساعد أيضًا إن نفدت مساحة البناء في المنتصف.

---

## النسخ الاحتياطي والترحيل

**كل الحالة تعيش داخل `rustdesk-stack/`:**

- **هوية الخادم + الأجهزة**: `data/hbbs/` (احتفظ بـ `id_ed25519*` و`db_v2.sqlite3*`).
  التثبيت من جديد فقط إن لم تكن تهتم بالمفتاح/الأجهزة.
- **قاعدة بيانات اللوحة**: `data/postgres/` — انسخها **بعد إيقاف الستاك**
  (`docker compose stop postgres`). يجب أن يبقى `POSTGRES_PASSWORD` في `.env` كما هو،
  فهو مضمّن في أدوار الكتلة المنسوخة.
- **TLS**: `data/certbot/etc/` (`cp -a` للحفاظ على الروابط الرمزية).

### الانتقال إلى مضيف إنتاج

```
# المضيف القديم
docker compose stop postgres
mkdir -p ~/rustdesk-migrate && cp -a RustDeskAdmin/data ~/rustdesk-migrate/data
tar czf ~/rustdesk-migrate/data.tgz -C ~/rustdesk-migrate data

# المضيف الجديد
git clone https://github.com/pierce1stg/RustDeskAdmin.git && cd RustDeskAdmin
cp .env.example .env            # اضبط DOMAIN وEMAIL وPOSTGRES_PASSWORD نفسه
mkdir -p data && tar xzf ~/rustdesk-migrate/data.tgz -C .
./setup.sh
```

أو استخدم `pg_dump`/الاستعادة لقاعدة بيانات اللوحة إن فضّلت تفريغ SQL.

---

## التحديث

جزءان مستقلان يُحدَّثان بشكل مختلف.

### لوحة الإدارة (backend / frontend / nginx / presence)

تستطيع اللوحة تحديث نفسها من إصدار موسوم (tagged release) على GitHub:

1. **من اللوحة (Settings → Panel update)**: يفحص أحدث إصدار **مستقر** `vX.Y.Z`، وينزّل الحزمة
   المفحوصة بـ SHA-256، ويستبدل كود اللوحة ويشغّل `./setup.sh` (من 1 إلى 3 دقائق، مع
   الحفاظ على البيانات و`.env`، وتراجع تلقائي عند الفشل). يعمل التحديث فقط عند الضغط
   على زر التحديث — لا تحدّث اللوحة نفسها تلقائيًا أبدًا. يتحكم به `ALLOW_PANEL_UPDATE`
   (الافتراضي `true`).
2. **يدويًا**: اسحب الكود وأعد تشغيل السكربت التمهيدي (idempotent):
   ```
   git pull
   ./setup.sh        # يعيد بناء الصور، مع الحفاظ على .env و data/
   ```

إصدار اللوحة الحالي ظاهر في تذييل الصفحة
(`backend/internal/appversion/version.go`).

الحالة (مفتاح الخادم، الأجهزة، قاعدة بيانات اللوحة، شهادات TLS) تعيش في `data/`
و`.env` ولا يلمسها `./setup.sh` أبدًا. جلسات `auth_sessions` تصمد عبر إعادة النشر.
إذا كانت نسخة الاستنساخ لديك أقدم من إعادة كتابة التاريخ، قد يفشل `git pull` برسالة
«unrelated histories» — عندها استنسخ من جديد وانقل `.env` و`data/` و`status/` إلى
الدليل الجديد، ثم شغّل `./setup.sh`.

### خادم RustDesk (hbbs / hbbr)

طريقتان لتحديث المرحّل (relay) إلى إصدار أحدث:

1. **فوريًا (من اللوحة)**: Settings → Server updates → تحقّق من الإصدار وطبّقه.
   يسحب الصورة ويعيد إنشاء الحاوية العاملة (يتراجع عند الفشل). يتحكم به
   `ALLOW_SERVER_UPDATE` (الافتراضي `true`).
2. **دائم (تثبيت compose)**: ارفع `RUSTDESK_SERVER_VERSION` في `.env` (الافتراضي
   `1.1.16`) وأعد تشغيل `./setup.sh`.

التحديث من اللوحة هو hot-swap حي: أمر `docker compose up` / `./setup.sh` التالي
سيعيد إنشاء hbbs/hbbr من `RUSTDESK_SERVER_VERSION` المثبّتة. لذا استخدم التثبيت
للإصدار الذي تريد إبقاءه فعليًا.

---

## استكشاف الأخطاء

- **القرص ممتلئ أثناء البناء**: الصور الافتراضية للإنتاج صغيرة؛ تأكد ألا شيء آخر
  يملأ المضيف. أضف swap إن كان RAM <2GB. تتراكم صور البناء القديمة في
  `/var/lib/containerd` — نظّفها:
  ```
  docker image prune -a -f; docker system prune -f
  ```
- **hbbr يدخل حلقة إعادة تشغيل**: `docker compose logs hbbr` — غالبًا تعارض منافذ أو
  غياب `/data` (ربط `./data/hbbs`).
- **فشل إصدار الشهادة / nginx «cannot load certificate»**: النسخ القديمة كانت تزحزح دليل
  `live/<DOMAIN>` لعمل certbot — نافذة قد يقع فيها nginx بحلقة إعادة تشغيل ويرى ACME
  «connection refused». `setup.sh` الحالي يبقي بلايسهولدر عاديًا في `live/<DOMAIN>`
  (لن يفقده nginx)، ويصدر الشهادة الحقيقية في خطّ مُستقل `live/<DOMAIN>-le`، وعند النجاح
  يوجّه `live/<DOMAIN>` إليه برابط رمزي. فحص صحة nginx وفحص مسبق للمنفذ 80 و3 محاولات
  تضمن نجاح التشغيل الأول.
- **presence.json فارغ**: تأكد أن حاوية `presence` ترى مقبس docker (تحتاج
  `privileged` + `pid: host`، وهذا ما توفره ملفات compose) وأن حاويتَي
  `rustdesk-hbbs`/`rustdesk-hbbr` موجودتان.
- **لا تنزيلات وحدات عبر الإنترنت**: صورة الخلفية للإنتاج تُبنى بـ `go mod vendor`
  ولا تحمل مخبأ الوحدات؛ صورة الواجهة حزمة ثابتة.
- **تسجيل الدخول لا يعمل**: يجب أن تكون كلمة المرور ≥8 أحرف؛ بعد البذر تعيش
  الإعدادات في قاعدة البيانات — تغيير `.env` لن يُطبَّق حتى تغيّره من اللوحة.
- **الخروج من اللوحة بعد مدة**: تخرج اللوحة عندما ينتهي رمز access ولا يعود رمز
  refresh قادرًا على مواصلة الجلسة. اضبط الأعمار من **الإعدادات ← الجلسة** (أو أعد
  البذر عبر `ACCESS_TOKEN_TTL_MINUTES` / `REFRESH_TOKEN_TTL_DAYS` في ستاك جديد).
  الجلسات محفوظة في postgres، فتتحمّل إعادة تشغيل الخادم ما لم يُمسح دليل البيانات.

---

## API (مرجع)

| الطريقة | المسار                      | الوصف                                          |
|---------|-----------------------------|------------------------------------------------|
| POST    | `/api/auth/login`           | تسجيل الدخول، يعيد access+refresh JWT          |
| POST    | `/api/auth/refresh`         | تجديد رمز access                               |
| PUT     | `/api/auth/password`        | تغيير بيانات admin (≥8 أحرف)                   |
| GET     | `/api/devices`              | قائمة الأجهزة (مقسمة صفحات)                    |
| PATCH   | `/api/devices/:id`          | تحديث جهاز (alias، pinned)                     |
| DELETE  | `/api/devices/:id`          | حذف جهاز                                       |
| GET     | `/api/devices/:id/password` | حالة كلمة المرور (لا تُعرض أبدًا)              |
| PUT     | `/api/devices/:id/password` | حفظ كلمة مرور مشفّرة                           |
| DELETE  | `/api/devices/:id/password` | حذف الكلمة المحفوظة                            |
| PATCH   | `/api/devices/peer/:peerId/peerinfo` | لقطة PeerInfo (المضيف/الإصدار/الشاشات) |
| GET     | `/api/status`               | حالة hbbs/hbbr الحية + الحضور                  |
| GET     | `/api/devices/stream`       | SSE: تحديثات حية لحالة online/offline          |
| GET     | `/api/settings`             | الإعدادات                                      |
| PUT     | `/api/settings/:key`        | تحديث إعداد                                    |
| PUT     | `/api/settings/auth_access_token_ttl_minutes` | ضبط صلاحية رمز access (بالدقائق) |
| PUT     | `/api/settings/auth_refresh_token_ttl_days`   | ضبط عمر الجلسة (بالأيام)          |
| GET     | `/api/server-info`          | العنوان/المنافذ/المفتاح مع المصادر              |
| GET     | `/api/server-info/connect-code` | رمز إعداد العميل: `json` (base64url معكوس)، `raw` (JSON)، `comma` (host=...) |
| GET     | `/health`                   | فحص الصحة                                      |

المصادقة: ترويسة `Authorization: Bearer <access_token>`.

> لا تُشحن مواصفة OpenAPI مع v1.0.0 — الجدول أعلاه وأدلة القبول هي المرجع.
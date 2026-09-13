# RustDesk Admin

<p align="center">
  [<a href="../README.md">English</a>] | [<a href="README-ZH.md">中文</a>] | [<a href="README-AR.md">العربية</a>]<br>
</p>

Единый репозиторий для развёртывания полностью контейнеризованного **RustDesk-сервера**
с веб-интерфейсом администрирования: ID-сервер + relay-сервер + панель управления +
«живое» присутствие устройств + автоматический TLS Let's Encrypt — всё в одном
проекте Docker Compose. Хост требует **только Docker** — никаких systemd-юнитов,
хост-certbot или хост-nginx отдельно.

> Этот проект полностью написан ИИ-ассистентом для кодинга — в репозитории
> нет ни одной строки рукописного кода.

Всё устойчиво к перезапускам: `docker compose restart`, перезагрузка сервера или
повторный запуск `./setup.sh` не теряют данные и настройки.

```
rustdesk-stack/
├── docker-compose.yml         # 8 сервисов, одна сеть
├── docker-compose.dev.yml     # опциональный overlay: air hot-reload + vite dev
├── setup.sh                   # первичный bootstrap (идемпотентный)
├── .env.example               # шаблон; скопируйте в .env
├── Makefile                   # вспомогательные команды (dev/build/logs/db ...)
├── backend/                   # Go admin API (компилируется в маленький prod-образ)
├── frontend/                  # React admin UI (статический nginx / SPA)
├── nginx/nginx.conf.template  # ${DOMAIN} + ACME webroot + WSS-терминация
├── presence/Dockerfile        # паззер присутствия (docker.sock + nsenter)
├── scripts/presence.sh        # снимок живых соединений (namespace hbbs/hbbr)
├── data/                      # ЖИВЫЕ ДАННЫЕ - создаётся setup.sh:
│   ├── hbbs/                  #   ключ hbbs/hbbr (id_ed25519) + БД устройств (sqlite)
│   ├── postgres/              #   каталог данных Postgres (bind mount)
│   └── certbot/etc/           #   Let's Encrypt live/archive/renewal
└── status/                    # presence.json (пишет presence-контейнер)
```

`data/` и `status/` исключены из git/tar и в архив не попадают.

## Скриншоты

| Светлая тема                                                 | Тёмная тема                                                |
|--------------------------------------------------------------|------------------------------------------------------------|
| ![Дашборд (светлая)](screenshots/Dashboard_white.png)        | ![Дашборд (тёмная)](screenshots/Dashboard_dark.png)        |

---

## Содержание

- [Функциональность](#функциональность)
- [Архитектура / сервисы](#архитектура--сервисы)
- [Предварительные требования](#предварительные-требования)
- [Установка с нуля](#установка-с-нуля)
- [Порты и настройка `.env`](#порты-и-настройка-env)
- [Сертификаты (Let's Encrypt)](#сертификаты-lets-encrypt)
- [Информация о сервере (Server Info)](#информация-о-сервере-server-info)
- [Web-клиент RustDesk](#web-клиент-rustdesk)
- [Строка подключения клиента](#строка-подключения-клиента)
- [Режим разработки (dev overlay)](#режим-разработки-dev-overlay)
- [Источники загрузки и зеркала (Block C)](#источники-загрузки-и-зеркала-block-c)
- [Очистка Docker после сборки (Block D)](#очистка-docker-после-сборки-block-d)
- [Резервное копирование и миграция](#резервное-копирование-и-миграция)
- [Устранение неполадок](#устранение-неполадок)
- [API (кратко)](#api-кратко)

---

## Функциональность

- **Веб-панель администрирования** (SPA React + Go API):
  - Dashboard — сводка состояния сервера, «живое» присутствие.
  - Devices — список зарегистрированных устройств (`GET /api/devices`), просмотр
    деталей, удаление.
  - Settings — настройки (крадут из seed'ов после первого входа, хранятся в БД);
    срок жизни сессии настраивается здесь же.
  - Login = JWT access + refresh токены с сессиями на сервере; сессии ротируются и
    чистятся при истечении refresh-токена; смена пароля админа.
- **Live-присутствие** (`presence`-контейнер):
  - читает реальные соединения hbbs/hbbr прямо из их network namespace (nsenter +
    `ss` + docker.sock);
  - пишет `status/presence.json` с активными peer IP, состоянием слушающих портов
    и привязками peer→IP;
  - статус также агрегируется бэкендом и выдаётся через `/api/status`.
- **RustDesk сервер**: hbbs (ID-сервер) + hbbr (relay) от официального образа
  `rustdesk/rustdesk-server:1.1.16`; ключ и БД устройств в `data/hbbs/`.
- **Writing-TLS**: самообслуживаемый Let's Encrypt (webroot), авто-обновление каждые
  12ч, а также WSS-терминация nginx на портах 21118/21119 для RustDesk TCP-mux.
- **Server Info** с источниками: клиенты/веб-клиент берут адрес/порты/ключ из API
  (`GET /api/server-info`) — каждое поле сообщает, откуда взято (env/naстройка/стек).
- **CORS для Web-клиента** rustdesk.com: заголовки разрешают web-клиент RustDesk.

---

## Архитектура / сервисы

| Сервис    | Образ                                                   | Назначение                                              |
|-----------|---------------------------------------------------------|---------------------------------------------------------|
| postgres  | postgres:16-alpine                                      | БД панели (`./data/postgres`), миграции при старте      |
| backend   | собирается (`backend/Dockerfile`, prod stage)           | REST API + WebSocket + чтение присутствия               |
| frontend  | собирается (`frontend/Dockerfile`, prod stage)          | админ-UI (статический nginx / SPA)                      |
| nginx     | nginx:alpine                                            | HTTPS-панель, ACME webroot, WSS 21118/21119             |
| hbbs      | rustdesk/rustdesk-server:1.1.16                         | ID-сервер (`-r ${DOMAIN}:21117`)                        |
| hbbr      | rustdesk/rustdesk-server:1.1.16                         | relay-сервер                                            |
| presence  | собирается (`presence/Dockerfile`)                      | считывание namespace → `status/presence.json`           |
| certbot   | certbot/certbot                                         | выпуск серта при первом запуске, обновление каждые 12ч  |

Все контейнеры с `restart: unless-stopped` — сами поднимаются после перезагрузки
ОС и перезапусков Docker.

---

## Предварительные требования

- Docker Engine + Docker Compose v2:
  ```
  apt update && apt install -y docker.io docker-compose-v2
  systemctl enable --now docker
  ```
- Публичный домен, указывающий (DNS A-запись) на этот сервер.
- Свободные TCP-порты: `80`, `443`, `21115`–`21119` (+ UDP `21116`, `21117`);
  все перемапливаются через `.env` (см. ниже).
- По умолчанию образы backend/frontend маленькие (≈50 МБ / несколько МБ).
  Dev-overlay требует несколько ГБ диска и ~2 ГБ RAM.
- Рекомендация для дешёвого железа (как 1.9Г RAM / 8.7Г диск): добавить swap-файл
  до сборки (сборки жрут память) и следить за свободным местом.

Пример фаервола (ufw):

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

## Установка с нуля

```
git clone https://github.com/pierce1stg/RustDeskAdmin.git
cd RustDeskAdmin
cp .env.example .env
# отредактируйте .env: DOMAIN=<ваш-домен>, LETSENCRYPT_EMAIL=<ваш-email>
./setup.sh
```

Перед запуском убедитесь, что `DOMAIN` резолвится (A-запись) на публичный IP этого
сервера и что порт 80 доступен из интернета — через него nginx отдаёт
Let's Encrypt HTTP-01 challenge. Если при первом запуске появится предупреждение
**«placeholder cert»** и остальное выглядит нормально — поправьте DNS/фаервол и
просто перезапустите `./setup.sh`: он идемпотентен и повторит выпуск с тем же доменом.

### Задать секреты вручную (необязательно)

`setup.sh` сам генерирует секреты, если они пустые/`changeme` (см. Блок A ниже).
Чтобы задать свои, выполните:

```
POSTGRES_PASSWORD=$(openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 32)
JWT_REFRESH_SECRET=$(openssl rand -base64 32)
```

...и впишите значения в `.env`. Можно оставить `changeme` — скрипт заменит их
случайными значениями при первом запуске.

`setup.sh` (идемпотентный) сделает:

1. сгенерирует `POSTGRES_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, если они
   пустые/`changeme`;
2. создаст `data/` и `status/`;
3. положит самоподписанный плейсхолдер в `data/certbot/etc/live/<DOMAIN>`, чтобы
   nginx всегда стартовал с TLS;
4. `docker compose up -d --build`;
5. дождётся, пока hbbs создаст `data/hbbs/db_v2.sqlite3`;
6. выпустит настоящий сертификат Let's Encrypt через HTTP-01 webroot на порту 80
   (`--cert-name <DOMAIN>`) и сразу перезагрузит nginx;
7. выведет сводку.

Повторный запуск `./setup.sh` в любой момент: пересборка, пересоздание контейнеров,
перевыпуск серта.

### Первый вход

Учётные данные админа сеются из блока B (`.env` → `ADMIN_USERNAME`/`ADMIN_PASSWORD`,
по умолчанию `admin`/`admin`). **Сразу смените пароль** в панели (Settings →
Admin credentials). Пароль должен быть ≥8 символов (проверяется на бэкенде).

---

## Порты и настройка `.env`

### Блок A (обязательное / секреты)

| Переменная           | Описание                                              |
|----------------------|-------------------------------------------------------|
| `DOMAIN`             | публичный hostname (DNS A → этот хост)                |
| `LETSENCRYPT_EMAIL`  | email для LE-уведомлений (обновления серта)           |
| `POSTGRES_PASSWORD`  | пароль Postgres (автогенерация, если `changeme`)      |
| `JWT_SECRET`         | секрет подписи JWT (автогенерация)                    |
| `JWT_REFRESH_SECRET` | секрет refresh-токенов (автогенерация)                |

### Блок B (разовые seeds — далее панель владеет настройками)

`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `STATUS_REFRESH_INTERVAL` (30с),
`SERVER_DISPLAY_ADDRESS` (опц. ручной адрес), `RUSTDESK_PUBLIC_KEY` (опц.; на
новом стеке hbbs генерирует ключ в `data/hbbs`), `RUSTDESK_ID_PORT`,
`RUSTDESK_RELAY_PORT`, `RUSTDESK_WS_PORT`, `ACCESS_TOKEN_TTL_MINUTES` (60),
`REFRESH_TOKEN_TTL_DAYS` (7).

### Срок жизни сессии (JWT TTL)

Access-токен закрывает каждый API-запрос; refresh-токен держит браузерную сессию
живой и ротируется при каждом обновлении. Оба настраиваемые — seed'ятся из `.env`
на новом стеке и редактируются в любое время в **Settings → Session**:

| Переменная                | По умолч. | Диапазон | Назначение                                       |
|---------------------------|-----------|----------|--------------------------------------------------|
| `ACCESS_TOKEN_TTL_MINUTES`| 60        | 5..10080 | срок жизни access-токена (минуты)                |
| `REFRESH_TOKEN_TTL_DAYS`  | 7         | 1..365   | сколько живёт неактивная сессия (дни)            |

Сессии хранятся на сервере в `auth_sessions` (postgres), поэтому активный вход
переживает рестарты бэкенда и редеплои. Изменение TTL влияет только на токены,
выданные после изменения; уже выданные истекают естественно, после чего панель
просто попросит войти снова.

### Маппинг портов хоста (всё опционально, значения по умолчанию)

| Переменная       | По умолч. | Назначение                               |
|------------------|-----------|------------------------------------------|
| `HTTP_PORT`      | 80        | ACME webroot / HTTP→HTTPS                |
| `HTTPS_PORT`     | 443       | панель по TLS                            |
| `NAT_PORT`       | 21115     | hbbs (NAT/сердцебиение)                  |
| `ID_PORT`        | 21116     | hbbs ID-сервер (tcp+udp)                 |
| `RELAY_PORT`     | 21117     | hbbr relay (tcp+udp)                     |
| `WSS_ID_PORT`    | 21118     | WSS → hbbs (TLS-терминация nginx)        |
| `WSS_RELAY_PORT` | 21119     | WSS → hbbr (TLS-терминация nginx)        |
| `API_PORT`       | 8080      | порт backend на хосте (отладка)          |

Внутри контейнеров слушающие порты фиксированы; параметризуется только маппинг на
хост. Пример: если 443 занят другим сервисом — поставьте `HTTPS_PORT=8443`.

---

## Сертификаты (Let's Encrypt)

- Bootstrap: плейсхолдер самиоподписан → у стека всегда TLS сразу.
- Выпуск: HTTP-01 webroot. Нужен хост-порт `80` (см. `HTTP_PORT`) и входящий
  TCP/UDP. Если `HTTP_PORT != 80`, авто-выпуск пропускается (поставьте 80 или
  выпустите серт вручную).
- Обновление: контейнер `certbot` каждые 12ч запускает `certbot renew --quiet`;
  nginx сам перезагружается каждые 6ч, чтобы подхватить новые серты (без docker CLI
  внутри certbot).

Флаг `--cert-name <DOMAIN>` заставляет certbot писать в
`data/certbot/etc/live/<DOMAIN>` — именно этот путь читает nginx-шаблон.

---

## Информация о сервере (Server Info)

`GET /api/server-info` возвращает каждое поле вместе с его **источником**:

| Поле           | Источники (приоритет)                                       |
|----------------|-------------------------------------------------------------|
| address        | ручной override → env `DOMAIN` → Host запроса               |
| relay address  | ручной override → env `RELAY_ADDRESS` → как адрес           |
| api server     | ручной override → env `RUSTDESK_API_SERVER` → пусто (не используется) |
| ports          | ручной override → env seeds → дефолты стека                |
| public key     | ручной override → `data/hbbs/id_ed25519.pub`                |

Клиенты/web-клиент используют эти значения; на новом стеке hbbs генерирует ключ при
первом старте, и backend подхватывает его автоматически (источник `rustdesk-server`).

---

## Web-клиент RustDesk

nslookup обратное: для подключения web-клиентом
(https://rustdesk.com/web) настройте Server Info панели на ваш `DOMAIN` и порты,
и используйте ключ из панели. CORS-заголовки в nginx разрешают origins
`rustdesk.com`/`web.rustdesk.com`.

---

## Строка подключения клиента

На Dashboard отображается готовая **строка подключения клиента** (Client Setup
Code), собираемая из текущего Server Info (`GET /api/server-info/connect-code`).
Скопируйте **Config code** в клиент RustDesk и вставьте в **Settings → Network →
Import** — клиент сам применит ID/relay-сервер, опциональный API-сервер и ключ:

| Форма | Пример |
|-------|--------|
| Config code | `=0nI9smcPhWR0YVcz1mekllS3JDbVNm...` — реверс от base64url (с паддингом) JSON `{"host","relay","api","key"}` |
| Raw JSON | `{"host":"<your-domain>","relay":"<your-domain>","api":"","key":"<your-public-key>"}` — тоже принимается Import |
| Альтернатива | `host=<your-domain>,key=<your-public-key>,relay=<your-domain>` |

Код **unsigned**: декодер клиента (`ServerConfig.decode` в
`flutter/lib/common.dart`) сначала пробует сырой JSON, затем реверс-base64url —
обе формы генерирует бэкенд. Подписанную форму из облачной веб-консоли
воспроизвести здесь нельзя (ключ подписи приватный). Нестандартные ID/relay-порты
встраиваются как `host:port` в соответствующее поле. В поле host допустимы домен,
IPv4 или IPv6 в скобках; значение API-сервера, если задано, обязано быть полным
URL `http(s)://`.

---

## Режим разработки (dev overlay)

Горячая перезагрузка с air и Vite dev-сервером (более тяжёлые образы, нужен
диск/RAM):

```
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Frontend dev-сервер слушает хост-порт `5173`. Backend запускается под `air` и
пересобирается при изменениях файлов.

---

## Источники загрузки и зеркала (Block C)

Все внешние загрузки стека идут через небольшой набор источников, которые можно
вручную перенаправить из `.env` (раздел `Block C` в `.env.example`). Чтобы применить
после правки — перезапустите `./setup.sh` (или `docker compose build`).

| Трафик                                   | Переменная              | Источник по умолчанию                 |
|------------------------------------------|-------------------------|----------------------------------------|
| Docker-образы (runtime + базовые `FROM`) | `DOCKER_REGISTRY_PREFIX` | Docker Hub (напр. `postgres:16-alpine`) |
| Go-модули + тул `air`                    | `GOPROXY`               | `https://proxy.golang.org,direct`      |
| npm-пакеты (frontend)                    | `NPM_REGISTRY`          | `https://registry.npmjs.org`           |
| Alpine apk-пакеты                        | `APK_MIRROR`            | `https://dl-cdn.alpinelinux.org/alpine`|

Примеры:

```
# Тянуть всё через приватный registry
DOCKER_REGISTRY_PREFIX=registry.example.com/

# Зеркало Go-прокси (Китай / ограниченные сети)
GOPROXY=https://goproxy.cn,direct

# Зеркало npm-реестра
NPM_REGISTRY=https://registry.npmmirror.com

# Зеркало Alpine (пути /v3.xx сохраняются, меняется только хост)
APK_MIRROR=https://mirror.example.com/alpine
```

Замечания:
- Пустые переменные = официальные источники.
- `DOCKER_REGISTRY_PREFIX` добавляется к каждой ссылке на образ (и `image:` в
  compose, и `FROM` в Dockerfiles), включая builder/base-образы.
- `APK_MIRROR` заменяет только хост `https://dl-cdn.alpinelinux.org/alpine` внутри
  собираемых образов, поэтому пути `/v3.xx/{main,community}` всегда совпадают с
  version Alpine базового образа.
- Failover ручной: Docker сам не переключается на зеркало. Указывайте значения
  заранее на хостах с ограниченным сетевым доступом.

---

## Очистка Docker после сборки (Block D)

`./setup.sh` в конце чистит неиспользуемые ресурсы Docker (раздел `Block D` в
`.env.example`), чтобы сборки не оставляли диск полным — важно на дешёвых VPS.

| `DOCKER_PRUNE_ON_BUILD` | Что удаляется                                                |
|-------------------------|--------------------------------------------------------------|
| `all` (по умолчанию)    | все образы, не используемые работающим контейнером (базовые build-образы `golang`/`node`/`python` alpine перекачиваются при следующей пересборке), остановленные одноразовые контейнеры, неиспользуемые сети/волумы |
| `safe`                  | только dangling-образы + build-кэш                           |
| `none`                  | без очистки                                                  |

Никогда не трогаются: образы, используемые работающим стеком
(`rustdesk-stack-*`, `postgres`, `nginx`, `certbot`, `rustdesk-server`) и каталог
`data/`. Если `all` удалил базовые build-образы — следующий `./setup.sh` скачает
их заново (~500 МБ). При тесном диске перед повторным `./setup.sh` полезно
заранее выполнить `docker image prune -a -f`, если сборка прервалась из-за места.

---

## Резервное копирование и миграция

**Всё состояние хранится внутри `rustdesk-stack/`:**

- **Идентичность сервера + устройства**: `data/hbbs/` (обязательно сохраните
  `id_ed25519*` и `db_v2.sqlite3*`). Свежие только если не нужны ключ/устройства.
- **БД панели**: `data/postgres/` — копируйте **после остановки стека**
  (`docker compose stop postgres`). `POSTGRES_PASSWORD` в `.env` обязан остаться тем
  же, он зашит в роли скопированного кластера.
- **TLS**: `data/certbot/etc/` (`cp -a`, чтобы сохранить симлинки).

### Перенос на продакшен-хост

```
# старый хост
docker compose stop postgres
mkdir -p ~/rustdesk-migrate && cp -a rustdesk-stack/data ~/rustdesk-migrate/data
tar czf ~/rustdesk-migrate/data.tgz -C ~/rustdesk-migrate data

# новый хост
git clone https://github.com/pierce1stg/RustDeskAdmin.git && cd RustDeskAdmin
cp .env.example .env            # DOMAIN, EMAIL, тот же POSTGRES_PASSWORD
mkdir -p data && tar xzf ~/rustdesk-migrate/data.tgz -C .
./setup.sh
```

Либо используйте `pg_dump`/restore для БД панели, если предпочитаете SQL-дамп.

---

## Устранение неполадок

- **Диск переполнен при сборках**: дефолтные прод-образы маленькие; убедитесь, что
  хост не заполнен. При низкой RAM (<2 ГБ) добавьте swap. После долгих сборок в
  `/var/lib/containerd` накапливаются старые образы — чистите:
  ```
  docker image prune -a -f; docker system prune -f
  ```
- **hbbr в crash-loop**: `docker compose logs hbbr` — обычно конфликт порта или
  отсутствие `/data` (bind `./data/hbbs`).
- **Выпуск сертификата падает / nginx "cannot load certificate"**: в старых сборках
  плейсхолдер `live/<DOMAIN>` уводился в сторону для certbot — окно, когда nginx мог
  уйти в crash-loop, а ACME видел "connection refused". Новый `setup.sh` держит обычный
  плейсхолдер в `live/<DOMAIN>` (nginx его никогда не теряет), выдаёт реальный серт во
  вспомогательную линейку `live/<DOMAIN>-le` и при успехе переключает `live/<DOMAIN>`
  на неё симлинком. Healthcheck nginx, префлайт порта 80 и 3 ретрая гарантируют выпуск
  с первого раза.
- **presence.json пуст**: убедитесь, что `presence`-контейнер видит docker.sock
  (нужен `privileged` + `pid: host` — есть в compose) и что существуют контейнеры
  `rustdesk-hbbs`/`rustdesk-hbbr`.
- **Нет скачивания модулей при сборке**: прод-образ backend собран с
  `go mod vendor` и без module cache; frontend — статический bundle.
- **Логин не работает**: пароль ≥8 символов; после seed'а настройки живут в БД —
  смена в `.env` не применится, пока не измените в панели.
- **Выкидывает из панели через время**: панель разлогинивает, когда истёк
  access-токен и refresh уже не может продолжать сессию. Подгоните время жизни в
  **Settings → Session** (или задайте через `ACCESS_TOKEN_TTL_MINUTES` /
  `REFRESH_TOKEN_TTL_DAYS` на свежем стеке). Сессии хранятся в postgres, так что
  переживают рестарты бэкенда, пока не стёрт каталог данных.

---

## API (кратко)

| Метод | Путь                 | Описание                                          |
|-------|----------------------|---------------------------------------------------|
| POST  | `/api/auth/login`    | вход, выдаёт access+refresh JWT                   |
| POST  | `/api/auth/refresh`  | обновление access-токена                          |
| PUT   | `/api/auth/password` | смена учётных данных админа (≥8 символов)         |
| GET   | `/api/devices`       | список устройств (пагинация)                      |
| PATCH | `/api/devices/:id`   | обновление устройства (alias, pinned)             |
| DELETE| `/api/devices/:id`   | удаление устройства                               |
| GET   | `/api/status`        | живой статус hbbs/hbbr + присутствие              |
| GET   | `/api/devices/stream`| SSE: живые обновления online/offline присутствия |
| GET   | `/api/settings`      | настройки                                         |
| PUT   | `/api/settings/:key` | обновление настройки                              |
| PUT   | `/api/settings/auth_access_token_ttl_minutes` | срок жизни access-токена (минуты) |
| PUT   | `/api/settings/auth_refresh_token_ttl_days`   | срок жизни сессии (дни)            |
| GET   | `/api/server-info`   | адрес/порты/ключ с источниками                    |
| GET   | `/api/server-info/connect-code` | код подключения клиента: `json` (реверс base64url), `raw` (JSON), `comma` (host=...) |
| GET   | `/health`            | health-check                                      |

Авторизация: заголовок `Authorization: Bearer <access_token>`.

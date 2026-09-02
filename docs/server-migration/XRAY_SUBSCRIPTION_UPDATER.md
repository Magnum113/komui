# Xray proxy и subscription updater KOMUI

Дата актуализации: 2 сентября 2026 года.

## Назначение

Telegram-алерты, order monitor и deploy bot используют локальный SOCKS-прокси:

```text
socks5h://127.0.0.1:10808
```

Xray не является входной точкой магазина и не должен слушать публичные
интерфейсы. Production-конфигурацию обновляет отдельный fail-closed updater с
двумя независимыми subscription providers.

## Текущее устройство

Source-controlled файлы:

```text
ops/server/komui-xray-subscription-update
ops/server/komui-xray-subscription-update.service
ops/server/komui-xray-subscription-update.timer
ops/server/tests/test_komui_xray_subscription_update.py
```

Установленные пути:

```text
/usr/local/bin/xray
/usr/local/sbin/komui-xray-subscription-update
/usr/local/etc/xray/config.json
/etc/systemd/system/komui-xray-subscription-update.service
/etc/systemd/system/komui-xray-subscription-update.timer
/var/lib/komui/xray-subscription/
```

Production использует Xray 26.3.27. Inbounds привязаны только к loopback:

```text
127.0.0.1:10808  SOCKS
127.0.0.1:10809  HTTP
```

Timer проверяет состояние каждые 15 минут. Загрузка subscription выполняется,
когда истёк provider interval или текущий proxy перестал проходить healthcheck.
Если активный provider здоров и refresh ещё не нужен, конфигурация не меняется.

## Секреты

URL providers и стабильный server HWID находятся только на сервере:

```text
/etc/komui-xray/subscription.url
/etc/komui-xray/subscription-secondary.url
/etc/komui-xray/subscription.hwid
```

Файлы принадлежат `root:root`, имеют mode `0600` и передаются unit через
systemd `LoadCredential`. Их значения нельзя выводить в journal, process
arguments, документацию, тестовые fixtures или Git.

## Алгоритм обновления

1. Updater восстанавливает незавершённую предыдущую activation по
   `pending.json`, если такой marker остался после сбоя.
2. Проверяет текущий SOCKS proxy и расписание активного provider.
3. Читает primary/secondary данные из systemd credential files, не передавая их
   в process arguments.
4. Загружает ответ по HTTPS с лимитом 5 MiB.
5. Строго разбирает поддерживаемые JSON либо Base64 VLESS/REALITY формы,
   отклоняя неизвестные поля, приватные endpoints и небезопасные transport
   параметры.
6. Ограничивает общий scan 32 profiles и резервирует три попытки для второго
   provider. Если второй provider недоступен или использовал не весь резерв,
   оставшиеся попытки возвращаются отложенным кандидатам первого. Если proxy
   был здоров в начале, но перестал отвечать во время refresh, альтернативный
   provider всё равно получает bounded шанс в том же запуске. Правило
   симметрично для активных primary и secondary.
7. Закрепляет hostname за проверенным публичным IP, сохраняя исходное имя только
   для SNI/Host; это закрывает DNS-rebind между проверкой и запуском.
8. Для каждого кандидата строит фиксированные loopback inbounds и запускает
   изолированный Xray canary от `nobody:nogroup`.
9. Candidate должен пройти syntax check, Cloudflare probe и Telegram probe.
10. Только после canary active config заменяется атомарно, Xray
    перезапускается и повторно проверяется через production SOCKS.
11. Ошибка activation восстанавливает точный предыдущий config/state. Если ни
    один кандидат не принят, ранее работающая production-конфигурация остаётся
    активной.

State format v2 хранит активный provider, отдельные refresh/preference данные
primary и secondary и last-success fingerprints. Updater предпочитает здоровый
активный provider, а при outage последовательно проверяет независимые providers.
Пять последних конфигураций сохраняются для rollback.

## Диагностика без изменения состояния

```bash
sudo systemctl status xray --no-pager -l
sudo systemctl status komui-xray-subscription-update.timer --no-pager -l
sudo systemctl status komui-xray-subscription-update.service --no-pager -l
sudo systemctl list-timers komui-xray-subscription-update.timer
sudo journalctl -u komui-xray-subscription-update.service -n 100 --no-pager
sudo /usr/local/bin/xray version
sudo /usr/local/bin/xray run -test -config /usr/local/etc/xray/config.json
ss -lntp | grep -E '127\.0\.0\.1:(10808|10809)'
curl --proxy socks5h://127.0.0.1:10808 --max-time 15 -fsS \
  https://cp.cloudflare.com/generate_204 -o /dev/null
```

Проверка наличия credential files не должна печатать содержимое:

```bash
sudo stat -c '%n %U:%G %a' \
  /etc/komui-xray/subscription.url \
  /etc/komui-xray/subscription-secondary.url \
  /etc/komui-xray/subscription.hwid
```

Успешный timer сам по себе не доказывает доставку Telegram. При проблеме нужно
проверить весь путь: caller → `/usr/local/sbin/komui-alert` → SOCKS 10808 →
Telegram API. Не отправлять искусственный пользовательский alert без отдельной
необходимости; для диагностики достаточно безопасного API/canary probe.

## Управляемый запуск и восстановление

Обычный refresh выполняет systemd timer. Ручной service run может заменить
production config и поэтому выполняется только как контролируемая операция:

```bash
sudo systemctl start komui-xray-subscription-update.service
sudo systemctl status komui-xray-subscription-update.service --no-pager -l
sudo systemctl is-active xray
```

Нельзя вручную копировать provider response в active config: updater намеренно
игнорирует provider inbounds/routing и заново строит разрешённый client config.
После сбоя сначала дать updater восстановить `pending.json`; удалять marker,
`state.json` или каталог backups вручную нельзя без отдельного разбора.

При восстановлении сервера порядок такой:

1. Установить проверенную версию Xray и source-controlled updater/units.
2. Восстановить root-only credentials вне Git.
3. Проверить unit через `systemd-analyze verify`.
4. Выполнить controlled service run и убедиться, что canary и production probe
   прошли.
5. Только после этого включить timer и проверить Telegram-dependent services.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now komui-xray-subscription-update.timer
```

Xray runtime и credential files входят в KOMUI backup v2, но encryption key
самого backup намеренно исключён и должен храниться отдельно от сервера.

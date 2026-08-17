//+------------------------------------------------------------------+
//|                                                    ArenaFeed.mq5 |
//|  Поток котировок для турнирной площадки Swing Zone Arena.        |
//|                                                                  |
//|  Автор: Vitaliy Yugay                                            |
//|  Почта: vamp.09.94@gmail.com                                     |
//|  GitHub: https://github.com/YugayV                               |
//+------------------------------------------------------------------+
//
// ЗАЧЕМ ЭТО НУЖНО
//
// Виджет TradingView на сайте — только картинка: данных из него на сервере
// нет. Зачёт турнира считается по собственному ряду свечей площадки, и
// заполнять его должен ровно тот фид, на котором участники торговали бы
// по-настоящему. Этот советник берёт закрытые минутные свечи вашего
// брокера и отправляет их на площадку.
//
// ВАЖНО: отправляются ТОЛЬКО ЗАКРЫТЫЕ свечи. Незакрытая свеча меняется на
// каждом тике, и если слать её, участники увидят «будущее» текущей минуты,
// а движок исполнит по ней ордера. Поэтому индекс 0 всегда пропускается.
//
// НАСТРОЙКА
//   1. Сервис -> Настройки -> Советники -> Разрешить WebRequest для URL,
//      добавить адрес площадки (например https://arena.up.railway.app).
//   2. Прикрепить советник к ЛЮБОМУ графику — одного достаточно. Список
//      инструментов задаётся в InpSymbols через запятую, например
//      XAUUSD,EURUSD,GBPUSD,USDJPY,BTCUSD. Пусто — берётся символ графика.
//      Если у брокера имена с суффиксом, InpSymbolAs переименует их:
//      "XAUUSD.m=XAUUSD,EURUSD.m=EURUSD".
//   3. Заполнить InpArenaUrl и InpIngestToken (тот же, что в переменной
//      окружения QUOTES_INGEST_TOKEN на сервере).
//
// Советник ничего не торгует и не изменяет ордера — только отправляет данные.
//
//+------------------------------------------------------------------+
#property copyright "Vitaliy Yugay"
#property link      "https://github.com/YugayV"
#property version   "1.00"
#property strict

input group                "Площадка"
input string   InpArenaUrl     = "";            // Адрес площадки, без /api
input string   InpIngestToken  = "";            // QUOTES_INGEST_TOKEN
input string   InpSymbols      = "";            // Список символов через запятую; пусто = символ графика
input string   InpSymbolAs     = "";            // Переименование: BROKER=ARENA через запятую

input group                "Поток"
input int      InpBackfillBars = 5000;          // Сколько минуток дослать при старте
input int      InpBatchSize    = 500;           // Свечей в одном запросе
input bool     InpVerbose      = true;          // Подробный лог

// Один советник кормит площадку сразу несколькими инструментами: держать
// по графику на каждый символ неудобно и легко забыть один из них.
string   g_symbols[];        // что отправляем
string   g_as[];             // под каким именем на площадке
datetime g_last_sent[];      // время последней отправленной свечи по каждому
bool     g_backfilled[];     // досланa ли история по этому символу
int      g_utc_offset = 0;   // насколько время сервера впереди UTC, секунды


//+------------------------------------------------------------------+
//| Смещение времени сервера относительно UTC                        |
//+------------------------------------------------------------------+
//
// САМОЕ ВАЖНОЕ МЕСТО В СОВЕТНИКЕ.
//
// MqlRates.time — это время СЕРВЕРА БРОКЕРА, а не UTC. У большинства
// брокеров сервер стоит на UTC+2 или UTC+3. Площадка же хранит время
// свечи в миллисекундах UTC. Если отправить время сервера как есть, весь
// ряд уедет на два-три часа ВПЕРЁД: свечи окажутся «из будущего»,
// проверка свежести решит, что поток идеален, свёртки в H1 и H4 сложатся
// по чужим границам, а ордера будут исполняться по сдвинутым ценам. И
// заметить это можно будет только по странным результатам сделок.
//
// Поэтому смещение считается и вычитается явно.
//
int ServerToUtcOffset()
  {
   long diff = (long)TimeCurrent() - (long)TimeGMT();

   // TimeCurrent между тиками отстаёт от настоящего времени, поэтому
   // округляем к ближайшим 15 минутам: реальные смещения брокеров
   // кратны им (бывают и получасовые, и UTC+5:45).
   long q = 900;
   long off = ((diff + (diff >= 0 ? q / 2 : -q / 2)) / q) * q;

   // Защита от неверных часов на машине: смещения больше 14 часов не
   // существует ни у одного брокера. Лучше не сдвигать вовсе, чем
   // сдвинуть на сутки.
   if(off > 14 * 3600 || off < -14 * 3600)
     {
      PrintFormat("ArenaFeed: подозрительное смещение %d с — проверьте часы "
                  "машины. Сдвиг не применяется.", (int)off);
      return(0);
     }
   return((int)off);
  }


//+------------------------------------------------------------------+
//| Разбор списка символов и таблицы переименований                   |
//+------------------------------------------------------------------+
void BuildSymbolList()
  {
   string raw = InpSymbols;
   StringTrimLeft(raw);
   StringTrimRight(raw);
   if(StringLen(raw) == 0)
      raw = _Symbol;

   string parts[];
   int n = StringSplit(raw, ',', parts);
   if(n <= 0)
     {
      ArrayResize(g_symbols, 1);
      ArrayResize(g_as, 1);
      g_symbols[0] = _Symbol;
      g_as[0] = _Symbol;
     }
   else
     {
      ArrayResize(g_symbols, n);
      ArrayResize(g_as, n);
      for(int i = 0; i < n; i++)
        {
         string sy = parts[i];
         StringTrimLeft(sy);
         StringTrimRight(sy);
         g_symbols[i] = sy;
         g_as[i] = sy;
        }
     }

   // таблица переименований: у брокера XAUUSD.m, а на площадке XAUUSD
   if(StringLen(InpSymbolAs) > 0)
     {
      string pairs[];
      int m = StringSplit(InpSymbolAs, ',', pairs);
      for(int i = 0; i < m; i++)
        {
         string kv[];
         if(StringSplit(pairs[i], '=', kv) == 2)
           {
            StringTrimLeft(kv[0]); StringTrimRight(kv[0]);
            StringTrimLeft(kv[1]); StringTrimRight(kv[1]);
            for(int j = 0; j < ArraySize(g_symbols); j++)
               if(g_symbols[j] == kv[0])
                  g_as[j] = kv[1];
           }
        }
     }

   int n2 = ArraySize(g_symbols);
   ArrayResize(g_last_sent, n2);
   ArrayResize(g_backfilled, n2);
   // Заполняем циклом, а не ArrayInitialize: у datetime и bool массивов
   // подходящей перегрузки может не оказаться, и код просто не соберётся.
   for(int i = 0; i < n2; i++)
     {
      g_last_sent[i] = 0;
      g_backfilled[i] = false;
     }

   // символ, которого нет в обзоре рынка, историю не отдаст
   for(int i = 0; i < ArraySize(g_symbols); i++)
      if(!SymbolSelect(g_symbols[i], true))
         PrintFormat("ArenaFeed: символ %s недоступен у брокера", g_symbols[i]);
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(InpArenaUrl) == 0 || StringLen(InpIngestToken) == 0)
     {
      Print("ArenaFeed: не заданы адрес площадки или токен — работа невозможна");
      return(INIT_PARAMETERS_INCORRECT);
     }

   BuildSymbolList();
   g_utc_offset = ServerToUtcOffset();
   PrintFormat("ArenaFeed: время сервера впереди UTC на %d мин",
               g_utc_offset / 60);

   for(int i = 0; i < ArraySize(g_symbols); i++)
      PrintFormat("ArenaFeed: %s -> %s", g_symbols[i], g_as[i]);

   for(int i = 0; i < ArraySize(g_symbols); i++)
      Backfill(i);

   EventSetTimer(20);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
  }
//+------------------------------------------------------------------+
// Проверяем не на каждом тике, а по таймеру: минутка закрывается раз в
// минуту, и опрашивать чаще незачем.
void OnTimer()
  {
   // Смещение пересчитываем: у брокеров бывает переход на летнее время,
   // и посреди работы советника оно может измениться на час.
   g_utc_offset = ServerToUtcOffset();

   for(int i = 0; i < ArraySize(g_symbols); i++)
     {
      // Историю добираем, пока она не подтянется: символ, которого не было
      // на графике, отдаёт её не сразу. Без этого повтора инструмент
      // остался бы вообще без истории до перезапуска советника.
      if(!g_backfilled[i])
         Backfill(i);
      SendClosedSince(i);
     }
  }
//+------------------------------------------------------------------+
//| Первичная заливка истории                                        |
//+------------------------------------------------------------------+
void Backfill(int idx)
  {
   MqlRates rates[];
   ArraySetAsSeries(rates, true);

   int got = CopyRates(g_symbols[idx], PERIOD_M1, 0, InpBackfillBars, rates);
   if(got <= 1)
     {
      // Это норма при первом обращении к символу, которого нет на графике:
      // терминал начинает подкачку истории асинхронно и возвращает -1.
      // Поэтому не сдаёмся, а повторим на следующем тике таймера.
      PrintFormat("ArenaFeed: история %s ещё не готова (%d) — повторю позже",
                  g_symbols[idx], got);
      return;
     }

   PrintFormat("ArenaFeed: %s — досылаю %d свечей", g_symbols[idx], got - 1);

   // индекс 0 — текущая незакрытая свеча, её пропускаем всегда
   for(int start = got - 1; start >= 1; start -= InpBatchSize)
     {
      int from = start;
      int to   = MathMax(1, start - InpBatchSize + 1);
      if(!Post(BuildBody(idx, rates, from, to)))
         break;
     }

   if(got >= 2)
     {
      g_last_sent[idx] = rates[1].time;
      g_backfilled[idx] = true;
     }
  }
//+------------------------------------------------------------------+
//| Отправка свечей, закрывшихся после указанного времени            |
//+------------------------------------------------------------------+
void SendClosedSince(int idx)
  {
   MqlRates rates[];
   ArraySetAsSeries(rates, true);

   int got = CopyRates(g_symbols[idx], PERIOD_M1, 0, InpBatchSize, rates);
   if(got <= 1)
      return;

   // считаем, сколько закрытых свечей новее, чем последняя отправленная
   int fresh = 0;
   for(int i = 1; i < got; i++)
     {
      if(rates[i].time <= g_last_sent[idx])
         break;
      fresh++;
     }
   if(fresh <= 0)
      return;

   if(Post(BuildBody(idx, rates, fresh, 1)))
     {
      g_last_sent[idx] = rates[1].time;
      if(InpVerbose)
         PrintFormat("ArenaFeed: %s — отправлено %d свечей, последняя %s",
                     g_as[idx], fresh,
                     TimeToString(rates[1].time, TIME_DATE|TIME_MINUTES));
     }
  }
//+------------------------------------------------------------------+
//| Сборка JSON: индексы идут от старших к младшим (from >= to)      |
//+------------------------------------------------------------------+
string BuildBody(int idx, const MqlRates &rates[], int from, int to)
  {
   // знаки после запятой берём у самого символа, а не у графика: на графике
   // золота цена EUR/USD округлилась бы до двух знаков и стала бы мусором
   int dg = (int)SymbolInfoInteger(g_symbols[idx], SYMBOL_DIGITS);
   if(dg <= 0)
      dg = _Digits;

   string s = "{\"symbol\":\"" + g_as[idx] + "\",\"tf\":\"M1\",\"candles\":[";

   bool first = true;
   for(int i = from; i >= to; i--)
     {
      if(!first)
         s += ",";
      first = false;

      // время сервера -> UTC: см. ServerToUtcOffset выше
      long ms = ((long)rates[i].time - g_utc_offset) * 1000;

      s += "{\"ts\":" + IntegerToString(ms) +
           ",\"o\":" + DoubleToString(rates[i].open,  dg) +
           ",\"h\":" + DoubleToString(rates[i].high,  dg) +
           ",\"l\":" + DoubleToString(rates[i].low,   dg) +
           ",\"c\":" + DoubleToString(rates[i].close, dg) +
           ",\"v\":" + IntegerToString(rates[i].tick_volume) + "}";
     }

   s += "]}";
   return(s);
  }
//+------------------------------------------------------------------+
//| POST на площадку                                                 |
//+------------------------------------------------------------------+
bool Post(const string body)
  {
   string url = InpArenaUrl;
   if(StringSubstr(url, StringLen(url) - 1, 1) == "/")
      url = StringSubstr(url, 0, StringLen(url) - 1);
   url += "/api/quotes/ingest";

   char    post[], result[];
   string  headers = "Content-Type: application/json\r\n" +
                     "X-Ingest-Token: " + InpIngestToken + "\r\n";
   string  answer;
   int     timeout = 10000;

   StringToCharArray(body, post, 0, StringLen(body), CP_UTF8);
   int res = WebRequest("POST", url, headers, timeout, post, result, answer);

   if(res == -1)
     {
      int err = GetLastError();
      PrintFormat("ArenaFeed: WebRequest не удался, ошибка %d. "
                  "Разрешён ли URL в настройках терминала?", err);
      return(false);
     }
   if(res != 200)
     {
      PrintFormat("ArenaFeed: площадка ответила %d: %s", res,
                  CharArrayToString(result, 0, MathMin(200, ArraySize(result))));
      return(false);
     }
   return(true);
  }
//+------------------------------------------------------------------+

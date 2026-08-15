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
//   2. Прикрепить советник к графику нужного символа. Таймфрейм графика
//      неважен: минутки берутся напрямую через CopyRates.
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
input string   InpSymbolAs     = "XAUUSD";      // Под каким именем слать символ

input group                "Поток"
input int      InpBackfillBars = 5000;          // Сколько минуток дослать при старте
input int      InpBatchSize    = 500;           // Свечей в одном запросе
input bool     InpVerbose      = true;          // Подробный лог

datetime g_last_sent = 0;   // время последней отправленной свечи

//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(InpArenaUrl) == 0 || StringLen(InpIngestToken) == 0)
     {
      Print("ArenaFeed: не заданы адрес площадки или токен — работа невозможна");
      return(INIT_PARAMETERS_INCORRECT);
     }

   Print("ArenaFeed: старт. Символ ", _Symbol, " -> ", InpSymbolAs);
   Backfill();
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
   SendClosedSince(g_last_sent);
  }
//+------------------------------------------------------------------+
//| Первичная заливка истории                                        |
//+------------------------------------------------------------------+
void Backfill()
  {
   MqlRates rates[];
   ArraySetAsSeries(rates, true);

   int need = InpBackfillBars;
   int got  = CopyRates(_Symbol, PERIOD_M1, 0, need, rates);
   if(got <= 1)
     {
      Print("ArenaFeed: история недоступна (", got, ")");
      return;
     }

   Print("ArenaFeed: досылаю историю, свечей ", got - 1);

   // индекс 0 — текущая незакрытая свеча, её пропускаем всегда
   for(int start = got - 1; start >= 1; start -= InpBatchSize)
     {
      int from = start;
      int to   = MathMax(1, start - InpBatchSize + 1);
      string body = BuildBody(rates, from, to);
      if(!Post(body))
         break;
     }

   if(got >= 2)
      g_last_sent = rates[1].time;
  }
//+------------------------------------------------------------------+
//| Отправка свечей, закрывшихся после указанного времени            |
//+------------------------------------------------------------------+
void SendClosedSince(datetime after)
  {
   MqlRates rates[];
   ArraySetAsSeries(rates, true);

   int got = CopyRates(_Symbol, PERIOD_M1, 0, InpBatchSize, rates);
   if(got <= 1)
      return;

   // считаем, сколько закрытых свечей новее, чем последняя отправленная
   int fresh = 0;
   for(int i = 1; i < got; i++)
     {
      if(rates[i].time <= after)
         break;
      fresh++;
     }
   if(fresh <= 0)
      return;

   string body = BuildBody(rates, fresh, 1);
   if(Post(body))
     {
      g_last_sent = rates[1].time;
      if(InpVerbose)
         PrintFormat("ArenaFeed: отправлено %d свечей, последняя %s",
                     fresh, TimeToString(rates[1].time, TIME_DATE|TIME_MINUTES));
     }
  }
//+------------------------------------------------------------------+
//| Сборка JSON: индексы идут от старших к младшим (from >= to)      |
//+------------------------------------------------------------------+
string BuildBody(const MqlRates &rates[], int from, int to)
  {
   string s = "{\"symbol\":\"" + InpSymbolAs + "\",\"tf\":\"M1\",\"candles\":[";

   bool first = true;
   for(int i = from; i >= to; i--)
     {
      if(!first)
         s += ",";
      first = false;

      // время свечи в миллисекундах UTC: сервер хранит именно так
      long ms = (long)rates[i].time * 1000;

      s += "{\"ts\":" + IntegerToString(ms) +
           ",\"o\":" + DoubleToString(rates[i].open,  _Digits) +
           ",\"h\":" + DoubleToString(rates[i].high,  _Digits) +
           ",\"l\":" + DoubleToString(rates[i].low,   _Digits) +
           ",\"c\":" + DoubleToString(rates[i].close, _Digits) +
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

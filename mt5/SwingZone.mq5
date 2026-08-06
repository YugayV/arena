//+------------------------------------------------------------------+
//|                                                    SwingZone.mq5 |
//|  Определение свинг-хай / свинг-лоу на H4, расчёт «площади работы» |
//|  и отправка сигнала торговому боту в схеме `swing-zone/v1`.      |
//|                                                                  |
//|  Установка:                                                      |
//|   1. Скопировать файл в MQL5/Experts, скомпилировать (F7).       |
//|   2. Сервис → Настройки → Советники → «Разрешить WebRequest для   |
//|      следующих URL» → добавить адрес бота.                        |
//|   3. Прикрепить к графику инструмента (таймфрейм любой —          |
//|      расчёт всегда ведётся по InpTimeframe).                      |
//+------------------------------------------------------------------+
#property copyright "Yugay Vitaliy"
#property link      "https://github.com/YugayV"
#property version   "1.00"
#property strict

//--- структура
input group                "Структура"
input ENUM_TIMEFRAMES      InpTimeframe   = PERIOD_H4;   // Таймфрейм расчёта
input int                  InpStrength    = 2;           // Сила свинга (баров слева/справа)
input double               InpMinMovePct  = 0.8;         // Мин. импульс, % диапазона
input int                  InpLookback    = 200;         // Окно анализа, баров

//--- сделка
input group                "Сделка"
input double               InpEntryFib    = 0.705;       // Вход по фибо (0.5 / 0.618 / 0.705 / 0.79)
input double               InpBufferPct   = 5.0;         // Буфер стопа, % зоны
input double               InpExtFib      = 0.272;       // Расширение для TP2
input double               InpRiskPct     = 1.0;         // Риск на сделку, % депозита

//--- интеграция
input group                "Интеграция"
input string               InpBotUrl      = "";          // URL бота (POST /signal)
input string               InpAuthToken   = "";          // Секрет для заголовка X-Auth-Token
input bool                 InpSendOnNewBar= true;        // Слать сигнал при смене структуры
input bool                 InpDrawObjects = true;        // Рисовать уровни на графике
input bool                 InpExportCsv   = false;       // Выгрузить свечи в CSV для дашборда
input string               InpCsvFile     = "swingzone_h4.csv";

#define PFX "SZ_"

//--- состояние
datetime g_lastBar      = 0;
double   g_lastZoneHigh = 0.0;
double   g_lastZoneLow  = 0.0;
int      g_atrHandle    = INVALID_HANDLE;

//+------------------------------------------------------------------+
struct Swing
  {
   int      idx;
   datetime time;
   double   price;
   int      type;   // 1 = high, -1 = low
  };

struct Plan
  {
   bool     valid;
   double   high, low, range, eq;
   datetime highTime, lowTime;
   int      bias;   // 1 = long, -1 = short
   double   entry, stop, tp1, tp2, oteLow, oteHigh;
   double   qty, rr1, rr2, riskUnit, riskMoney, atr;
   double   lastClose;
   datetime lastTime;
   string   location;
   int      bars;
  };

//+------------------------------------------------------------------+
int OnInit()
  {
   g_atrHandle = iATR(_Symbol, InpTimeframe, 14);
   if(g_atrHandle == INVALID_HANDLE)
      Print("SwingZone: не удалось создать индикатор ATR");

   if(InpStrength < 1 || InpLookback < 20)
     {
      Print("SwingZone: некорректные параметры структуры");
      return(INIT_PARAMETERS_INCORRECT);
     }

   EventSetTimer(15);
   Recalculate(true);
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(g_atrHandle != INVALID_HANDLE)
      IndicatorRelease(g_atrHandle);
   ObjectsDeleteAll(0, PFX);
   ChartRedraw();
  }

//+------------------------------------------------------------------+
void OnTimer() { Recalculate(false); }
void OnTick()  { Recalculate(false); }

//+------------------------------------------------------------------+
//| Пересчёт при появлении новой закрытой свечи                       |
//+------------------------------------------------------------------+
void Recalculate(const bool force)
  {
   datetime bar = iTime(_Symbol, InpTimeframe, 1);
   if(bar == 0)
      return;
   if(!force && bar == g_lastBar)
      return;
   g_lastBar = bar;

   MqlRates rates[];
   ArraySetAsSeries(rates, false);           // index 0 = самая старая свеча
   int copied = CopyRates(_Symbol, InpTimeframe, 1, InpLookback, rates);
   if(copied < 20)
     {
      Print("SwingZone: недостаточно истории (", copied, " баров)");
      return;
     }

   Plan plan = BuildPlan(rates, copied);
   if(!plan.valid)
      return;

   if(InpDrawObjects)
      DrawPlan(plan);

   if(InpExportCsv)
      ExportCsv(rates, copied);

   bool changed = (MathAbs(plan.high - g_lastZoneHigh) > _Point ||
                   MathAbs(plan.low  - g_lastZoneLow)  > _Point);

   PrintFormat("SwingZone %s H4 | bias=%s | зона %s–%s | entry %s | stop %s | tp1 %s | R:R %.2f",
               _Symbol, plan.bias > 0 ? "LONG" : "SHORT",
               DoubleToString(plan.low, _Digits), DoubleToString(plan.high, _Digits),
               DoubleToString(plan.entry, _Digits), DoubleToString(plan.stop, _Digits),
               DoubleToString(plan.tp1, _Digits), plan.rr1);

   if(changed && InpSendOnNewBar && StringLen(InpBotUrl) > 0)
      SendSignal(plan);

   g_lastZoneHigh = plan.high;
   g_lastZoneLow  = plan.low;
  }

//+------------------------------------------------------------------+
//| Поиск свингов и построение торгового плана                        |
//+------------------------------------------------------------------+
Plan BuildPlan(const MqlRates &rates[], const int n)
  {
   Plan p;
   ZeroMemory(p);
   p.valid = false;
   p.bars  = n;

   double winHigh = rates[0].high, winLow = rates[0].low;
   for(int i = 1; i < n; i++)
     {
      winHigh = MathMax(winHigh, rates[i].high);
      winLow  = MathMin(winLow,  rates[i].low);
     }
   double minMoveAbs = (winHigh - winLow) * InpMinMovePct / 100.0;

   //--- фрактальные экстремумы
   Swing piv[];
   int k = InpStrength;
   for(int i = k; i < n - k; i++)
     {
      bool isHigh = true, isLow = true;
      for(int j = i - k; j <= i + k && (isHigh || isLow); j++)
        {
         if(j == i)
            continue;
         if(rates[j].high > rates[i].high || (rates[j].high == rates[i].high && j < i))
            isHigh = false;
         if(rates[j].low  < rates[i].low  || (rates[j].low  == rates[i].low  && j < i))
            isLow = false;
        }
      if(isHigh)
        {
         int s = ArraySize(piv);
         ArrayResize(piv, s + 1);
         piv[s].idx = i; piv[s].time = rates[i].time; piv[s].price = rates[i].high; piv[s].type = 1;
        }
      if(isLow)
        {
         int s = ArraySize(piv);
         ArrayResize(piv, s + 1);
         piv[s].idx = i; piv[s].time = rates[i].time; piv[s].price = rates[i].low; piv[s].type = -1;
        }
     }

   //--- зигзаг: чередующиеся свинги с фильтром импульса
   Swing seq[];
   for(int i = 0; i < ArraySize(piv); i++)
     {
      int m = ArraySize(seq);
      if(m == 0)
        {
         ArrayResize(seq, 1);
         seq[0] = piv[i];
         continue;
        }
      if(piv[i].type == seq[m - 1].type)
        {
         bool better = piv[i].type == 1 ? piv[i].price > seq[m - 1].price
                                        : piv[i].price < seq[m - 1].price;
         if(better)
            seq[m - 1] = piv[i];
         continue;
        }
      if(MathAbs(piv[i].price - seq[m - 1].price) < minMoveAbs)
         continue;
      ArrayResize(seq, m + 1);
      seq[m] = piv[i];
     }

   int m = ArraySize(seq);
   if(m >= 2)
     {
      Swing a = seq[m - 2], b = seq[m - 1];
      Swing hi = (a.type == 1) ? a : b;
      Swing lo = (a.type == -1) ? a : b;
      p.high = hi.price; p.highTime = hi.time;
      p.low  = lo.price; p.lowTime  = lo.time;
      p.bias = (b.type == 1) ? 1 : -1;
     }
   else
     {
      p.high = winHigh; p.low = winLow;
      p.highTime = 0;   p.lowTime = 0;
      p.bias = 1;
     }

   p.range = p.high - p.low;
   if(p.range <= 0.0)
      return p;

   p.eq        = p.low + p.range / 2.0;
   p.entry     = FibLevel(p, InpEntryFib);
   p.oteHigh   = MathMax(FibLevel(p, 0.618), FibLevel(p, 0.79));
   p.oteLow    = MathMin(FibLevel(p, 0.618), FibLevel(p, 0.79));
   double buf  = p.range * InpBufferPct / 100.0;
   p.stop      = (p.bias > 0) ? p.low - buf : p.high + buf;
   p.tp1       = (p.bias > 0) ? p.high : p.low;
   p.tp2       = (p.bias > 0) ? p.high + InpExtFib * p.range : p.low - InpExtFib * p.range;

   p.riskUnit  = MathAbs(p.entry - p.stop);
   p.riskMoney = AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPct / 100.0;
   p.qty       = (p.riskUnit > 0.0) ? p.riskMoney / p.riskUnit : 0.0;
   p.rr1       = (p.riskUnit > 0.0) ? MathAbs(p.tp1 - p.entry) / p.riskUnit : 0.0;
   p.rr2       = (p.riskUnit > 0.0) ? MathAbs(p.tp2 - p.entry) / p.riskUnit : 0.0;

   p.lastClose = rates[n - 1].close;
   p.lastTime  = rates[n - 1].time;
   p.location  = (MathAbs(p.lastClose - p.eq) / p.range < 0.02) ? "equilibrium"
                 : (p.lastClose > p.eq ? "premium" : "discount");

   double atrBuf[];
   if(g_atrHandle != INVALID_HANDLE && CopyBuffer(g_atrHandle, 0, 1, 1, atrBuf) == 1)
      p.atr = atrBuf[0];

   p.valid = true;
   return p;
  }

//+------------------------------------------------------------------+
double FibLevel(const Plan &p, const double f)
  {
   return (p.bias > 0) ? p.high - f * p.range : p.low + f * p.range;
  }

//+------------------------------------------------------------------+
//| Отрисовка уровней                                                 |
//+------------------------------------------------------------------+
void DrawPlan(const Plan &p)
  {
   HLine("high",  p.high,  clrMagenta,     STYLE_DASH,  "SWING HIGH");
   HLine("low",   p.low,   clrMagenta,     STYLE_DASH,  "SWING LOW");
   HLine("eq",    p.eq,    clrOrange,      STYLE_DOT,   "EQ 50%");
   HLine("entry", p.entry, clrDeepSkyBlue, STYLE_SOLID, "ENTRY");
   HLine("stop",  p.stop,  clrTomato,      STYLE_SOLID, "STOP");
   HLine("tp1",   p.tp1,   clrMediumSpringGreen, STYLE_SOLID, "TP1");
   HLine("tp2",   p.tp2,   clrMediumSpringGreen, STYLE_DOT,   "TP2");
   HLine("oteHi", p.oteHigh, clrMediumPurple, STYLE_DOT, "OTE 0.79/0.618");
   HLine("oteLo", p.oteLow,  clrMediumPurple, STYLE_DOT, "");
   ChartRedraw();
  }

void HLine(const string id, const double price, const color col,
           const ENUM_LINE_STYLE style, const string text)
  {
   string name = PFX + id;
   if(ObjectFind(0, name) < 0)
      ObjectCreate(0, name, OBJ_HLINE, 0, 0, price);
   ObjectSetDouble(0, name, OBJPROP_PRICE, price);
   ObjectSetInteger(0, name, OBJPROP_COLOR, col);
   ObjectSetInteger(0, name, OBJPROP_STYLE, style);
   ObjectSetInteger(0, name, OBJPROP_WIDTH, 1);
   ObjectSetInteger(0, name, OBJPROP_BACK, true);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetString(0, name, OBJPROP_TOOLTIP, text + " " + DoubleToString(price, _Digits));
  }

//+------------------------------------------------------------------+
//| ISO-8601 UTC из серверного времени                                |
//+------------------------------------------------------------------+
string IsoUtc(const datetime serverTime)
  {
   if(serverTime == 0)
      return "null";
   datetime utc = serverTime - (TimeCurrent() - TimeGMT());
   MqlDateTime d;
   TimeToStruct(utc, d);
   return StringFormat("\"%04d-%02d-%02dT%02d:%02d:%02dZ\"",
                       d.year, d.mon, d.day, d.hour, d.min, d.sec);
  }

string Num(const double v) { return DoubleToString(v, _Digits); }

//+------------------------------------------------------------------+
//| Сборка payload `swing-zone/v1`                                    |
//+------------------------------------------------------------------+
string BuildPayload(const Plan &p)
  {
   string side = (p.bias > 0) ? "buy" : "sell";
   string bias = (p.bias > 0) ? "long" : "short";
   double inval = (p.bias > 0) ? p.low : p.high;

   string j = "{";
   j += "\"schema\":\"swing-zone/v1\",";
   j += "\"source\":\"mt5\",";
   j += "\"generated_at\":" + IsoUtc(TimeCurrent()) + ",";
   j += "\"symbol\":\"" + _Symbol + "\",";
   j += "\"timeframe\":\"4h\",";
   j += "\"window\":{\"from\":" + IsoUtc(p.lastTime) + ",\"to\":" + IsoUtc(p.lastTime) +
        ",\"candles\":" + IntegerToString(p.bars) + "},";
   j += "\"swing\":{";
   j += "\"high\":{\"price\":" + Num(p.high) + ",\"time\":" + IsoUtc(p.highTime) + ",\"source\":\"fractal\"},";
   j += "\"low\":{\"price\":"  + Num(p.low)  + ",\"time\":" + IsoUtc(p.lowTime)  + ",\"source\":\"fractal\"},";
   j += "\"leg_direction\":\"" + (p.bias > 0 ? "up" : "down") + "\",";
   j += "\"strength_bars\":" + IntegerToString(InpStrength) + "},";
   j += "\"zone\":{";
   j += "\"upper\":" + Num(p.high) + ",\"lower\":" + Num(p.low) + ",";
   j += "\"height\":" + Num(p.range) + ",\"equilibrium\":" + Num(p.eq) + ",";
   j += "\"ote\":[" + Num(p.oteLow) + "," + Num(p.oteHigh) + "]},";
   j += "\"bias\":\"" + bias + "\",";
   j += "\"trade\":{";
   j += "\"side\":\"" + side + "\",\"order_type\":\"limit\",";
   j += "\"entry\":" + Num(p.entry) + ",\"stop_loss\":" + Num(p.stop) + ",";
   j += "\"take_profit\":[" + Num(p.tp1) + "," + Num(p.tp2) + "],";
   j += "\"rr\":[" + DoubleToString(p.rr1, 2) + "," + DoubleToString(p.rr2, 2) + "],";
   j += "\"risk_pct\":" + DoubleToString(InpRiskPct, 2) + ",";
   j += "\"risk_amount\":" + DoubleToString(p.riskMoney, 2) + ",";
   j += "\"position_size\":" + DoubleToString(p.qty, 4) + ",";
   j += "\"invalidation\":" + Num(inval) + "},";
   j += "\"context\":{";
   j += "\"last_close\":" + Num(p.lastClose) + ",";
   j += "\"last_candle_time\":" + IsoUtc(p.lastTime) + ",";
   j += "\"price_location\":\"" + p.location + "\",";
   j += "\"atr14\":" + Num(p.atr) + ",";
   j += "\"price_digits\":" + IntegerToString(_Digits) + "}";
   j += "}";
   return j;
  }

//+------------------------------------------------------------------+
//| Отправка сигнала боту                                             |
//+------------------------------------------------------------------+
void SendSignal(const Plan &p)
  {
   string payload = BuildPayload(p);
   string headers = "Content-Type: application/json\r\n";
   if(StringLen(InpAuthToken) > 0)
      headers += "X-Auth-Token: " + InpAuthToken + "\r\n";

   char post[], result[];
   string resultHeaders;
   int len = StringToCharArray(payload, post, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   if(len < 0)
      len = 0;
   ArrayResize(post, len);

   ResetLastError();
   int status = WebRequest("POST", InpBotUrl, headers, 5000, post, result, resultHeaders);

   if(status == -1)
     {
      int err = GetLastError();
      PrintFormat("SwingZone: WebRequest не выполнен (ошибка %d). "
                  "Добавьте %s в список разрешённых URL: Сервис → Настройки → Советники.",
                  err, InpBotUrl);
      return;
     }

   string answer = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   PrintFormat("SwingZone: бот ответил HTTP %d — %s", status, StringSubstr(answer, 0, 400));
  }

//+------------------------------------------------------------------+
//| Экспорт свечей в CSV для веб-дашборда                             |
//+------------------------------------------------------------------+
void ExportCsv(const MqlRates &rates[], const int n)
  {
   int h = FileOpen(InpCsvFile, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
     {
      PrintFormat("SwingZone: не удалось открыть %s (ошибка %d)", InpCsvFile, GetLastError());
      return;
     }
   FileWriteString(h, "datetime,open,high,low,close,volume\n");
   for(int i = 0; i < n; i++)
     {
      MqlDateTime d;
      TimeToStruct(rates[i].time, d);
      FileWriteString(h, StringFormat("%04d-%02d-%02d %02d:%02d,%s,%s,%s,%s,%d\n",
                                      d.year, d.mon, d.day, d.hour, d.min,
                                      DoubleToString(rates[i].open,  _Digits),
                                      DoubleToString(rates[i].high,  _Digits),
                                      DoubleToString(rates[i].low,   _Digits),
                                      DoubleToString(rates[i].close, _Digits),
                                      (int)rates[i].tick_volume));
     }
   FileClose(h);
   PrintFormat("SwingZone: экспортировано %d свечей в MQL5/Files/%s", n, InpCsvFile);
  }
//+------------------------------------------------------------------+

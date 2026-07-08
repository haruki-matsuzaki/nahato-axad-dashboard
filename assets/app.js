const state = {
  index: null,
  data: null,
  overallSales: null,
  overallBusinessSales: null,
  view: "home",
  chartMetric: "sales",
  sortKey: "grossProfit",
  expandedProjects: new Set(),
  expandedBusinessUnits: new Set(),
  showBusinessDetailColumns: false,
  theme: "dark",
  weatherLabel: "東京 --℃ / --",
  user: {
    name: "松﨑陽紀",
    email: "matsuzaki@axis-company.jp",
  },
};

const els = {
  sidebarUpdated: document.querySelector("#sidebarUpdated"),
  loginScreen: document.querySelector("#loginScreen"),
  loginButton: document.querySelector("#loginButton"),
  loginThemeToggle: document.querySelector("#loginThemeToggle"),
  dateLabel: document.querySelector("#dateLabel"),
  timeLabel: document.querySelector("#timeLabel"),
  weatherLabel: document.querySelector("#weatherLabel"),
  sourceLabel: document.querySelector("#sourceLabel"),
  pageTitle: document.querySelector("#pageTitle"),
  notice: document.querySelector("#notice"),
  kpiGrid: document.querySelector("#kpiGrid"),
  monthSelect: document.querySelector("#monthSelect"),
  startDate: document.querySelector("#startDate"),
  endDate: document.querySelector("#endDate"),
  projectSelect: document.querySelector("#projectSelect"),
  mediaSelect: document.querySelector("#mediaSelect"),
  homeView: document.querySelector("#homeView"),
  mypageView: document.querySelector("#mypageView"),
  overallView: document.querySelector("#overallView"),
  dailyChart: document.querySelector("#dailyChart"),
  chartMetricTabs: document.querySelector("#chartMetricTabs"),
  mediaBreakdown: document.querySelector("#mediaBreakdown"),
  projectTop: document.querySelector("#projectTop"),
  summaryPanel: document.querySelector("#summaryPanel"),
  periodLabel: document.querySelector("#periodLabel"),
  sheetTableHead: document.querySelector("#sheetTableHead"),
  detailTable: document.querySelector("#detailTable"),
  tableCount: document.querySelector("#tableCount"),
  detailTableWrap: document.querySelector("#detailTableWrap"),
  detailTableScrollProxy: document.querySelector("#detailTableScrollProxy"),
  overallSheetMeta: document.querySelector("#overallSheetMeta"),
  overallSalesTable: document.querySelector("#overallSalesTable"),
  overallSalesScrollProxy: document.querySelector("#overallSalesScrollProxy"),
  floatingScrollProxy: document.querySelector("#floatingScrollProxy"),
  overallBusinessColumnToggle: document.querySelector("#overallBusinessColumnToggle"),
  overallBusinessMeta: document.querySelector("#overallBusinessMeta"),
  overallBusinessTable: document.querySelector("#overallBusinessTable"),
  overallBusinessScrollProxy: document.querySelector("#overallBusinessScrollProxy"),
  sortGross: document.querySelector("#sortGross"),
  sortSales: document.querySelector("#sortSales"),
  menuToggle: document.querySelector("#menuToggle"),
  themeToggle: document.querySelector("#themeToggle"),
  profileMenuButton: document.querySelector("#profileMenuButton"),
  profileMenu: document.querySelector("#profileMenu"),
  logoutButton: document.querySelector("#logoutButton"),
};

const themeStorageKey = "nacht-axad-theme";
const authStorageKey = "nacht-axad-auth";
const accessIdentityEndpoint = "/cdn-cgi/access/get-identity";
const fallbackUser = {
  name: "松﨑陽紀",
  email: "matsuzaki@axis-company.jp",
};

const metricDefinitions = [
  { key: "sales", label: "売上", icon: "¥", format: formatYen },
  { key: "grossProfit", label: "粗利", icon: "↗", format: formatYen, signed: true },
  { key: "cost", label: "消化金額", icon: "$", format: formatYen },
  { key: "roas", label: "ROAS", icon: "%", format: formatPercent },
  { key: "cv", label: "CV", icon: "◎", format: formatNumber },
  { key: "cpa", label: "CPA", icon: "¥", format: formatYen },
];

const chartMetrics = [
  { key: "sales", label: "売上" },
  { key: "grossProfit", label: "粗利" },
  { key: "cost", label: "消化金額" },
  { key: "roas", label: "ROAS" },
];

const projectRankColor = "#6db1dc";
const rankPalette = ["#6cb7df", "#35c98d", "#7aa4ff", "#e4c45d", "#aa9ce4", "#5ec6bd", "#8fb0c9", "#c8a6e8"];
const mediaColorMap = {
  FB: "#aac1f0",
  YT: "#de9d9b",
  TIKTOK: "#cea8bc",
  PANGLE: "#f2cda2",
  X: "#a9c3c8",
  LINE: "#bdd6ac",
};
const mediaRankColorMap = {
  FB: "#77a5e8",
  YT: "#d67e7b",
  TIKTOK: "#bf7fa2",
  PANGLE: "#e8b06d",
  X: "#7eacb3",
  LINE: "#8fbd7a",
};

init();

async function init() {
  bindEvents();
  initTheme();
  initAuthGate();
  await loadAuthenticatedUser();
  startClock();
  fetchTokyoWeather();
  window.setInterval(fetchTokyoWeather, 10 * 60 * 1000);

  try {
    state.index = await fetchJson("data/index.json");
    populateMonthSelect();
    await loadMonth(state.index.defaultMonth || state.index.months?.[0]?.id);
  } catch (error) {
    showNotice("データを読み込めませんでした");
    renderEmpty();
    console.error(error);
  }
}

function bindEvents() {
  bindScrollProxies();

  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      setView(link.dataset.view);
      history.replaceState(null, "", `#${link.dataset.view}`);
      if (state.data) render();
      document.body.classList.remove("sidebar-open");
    });
  });

  els.monthSelect.addEventListener("change", () => loadMonth(els.monthSelect.value));
  [els.startDate, els.endDate, els.projectSelect, els.mediaSelect].forEach((el) => {
    el.addEventListener("change", render);
  });

  els.sortGross?.addEventListener("click", () => {
    state.sortKey = "grossProfit";
    render();
  });

  els.sortSales?.addEventListener("click", () => {
    state.sortKey = "sales";
    render();
  });

  els.detailTable.addEventListener("click", (event) => {
    const button = event.target.closest("[data-project-toggle]");
    if (!button) return;
    const project = button.dataset.projectToggle;
    if (state.expandedProjects?.has(project)) {
      state.expandedProjects.delete(project);
    } else {
      if (!state.expandedProjects) state.expandedProjects = new Set();
      state.expandedProjects.add(project);
    }
    renderDetailTable(getFilteredRecords());
  });

  els.overallBusinessTable?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-business-unit-toggle]");
    if (!button) return;
    const unit = button.dataset.businessUnitToggle;
    if (state.expandedBusinessUnits?.has(unit)) {
      state.expandedBusinessUnits.delete(unit);
    } else {
      if (!state.expandedBusinessUnits) state.expandedBusinessUnits = new Set();
      state.expandedBusinessUnits.add(unit);
    }
    renderOverallBusinessSales();
  });

  els.overallBusinessColumnToggle?.addEventListener("click", () => {
    state.showBusinessDetailColumns = !state.showBusinessDetailColumns;
    renderOverallBusinessSales();
  });

  els.menuToggle.addEventListener("click", () => {
    document.body.classList.toggle("sidebar-open");
  });

  els.themeToggle.addEventListener("click", () => {
    applyTheme(state.theme === "light" ? "dark" : "light", true);
  });

  els.loginThemeToggle?.addEventListener("click", () => {
    applyTheme(state.theme === "light" ? "dark" : "light", true);
  });

  els.loginButton?.addEventListener("click", async () => {
    localStorage.setItem(authStorageKey, "ok");
    document.body.classList.remove("auth-locked");
    await loadAuthenticatedUser();
    queueScrollProxyUpdate();
  });

  els.profileMenuButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleProfileMenu();
  });

  els.profileMenu?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  document.addEventListener("click", closeProfileMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeProfileMenu();
  });

  els.logoutButton?.addEventListener("click", () => {
    localStorage.removeItem(authStorageKey);
    closeProfileMenu();
    document.body.classList.add("auth-locked");
  });

  const initialHash = location.hash.replace("#", "");
  if (initialHash === "overallBusiness") {
    state.view = "overall";
  } else if (["mypage", "overall"].includes(initialHash)) {
    state.view = initialHash;
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem(themeStorageKey);
  applyTheme(savedTheme === "light" ? "light" : "dark", false);
}

function initAuthGate() {
  const authenticated = localStorage.getItem(authStorageKey) === "ok";
  document.body.classList.toggle("auth-locked", !authenticated);
}

async function loadAuthenticatedUser() {
  const identity = await fetchAccessIdentity();
  state.user = normalizeAccessUser(identity) || fallbackUser;
  renderUserProfile();
}

async function fetchAccessIdentity() {
  try {
    const response = await fetch(accessIdentityEndpoint, {
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeAccessUser(identity) {
  if (!identity || typeof identity !== "object") return null;
  const name = normalizeText(
    identity.name ||
      identity.display_name ||
      identity.user?.name ||
      identity.user?.display_name ||
      identity.claims?.name ||
      identity.idp?.claims?.name,
  );
  const email = normalizeText(
    identity.email ||
      identity.user?.email ||
      identity.claims?.email ||
      identity.idp?.claims?.email ||
      identity.user_email,
  );
  if (!name && !email) return null;
  return {
    name: name || emailName(email),
    email,
  };
}

function renderUserProfile() {
  const user = state.user || fallbackUser;
  const name = normalizeText(user.name) || fallbackUser.name;
  const email = normalizeText(user.email);
  document.querySelectorAll(".profile-name, .profile-menu-name").forEach((element) => {
    element.textContent = name;
    element.setAttribute("title", name);
  });
  document.querySelectorAll(".profile-menu-email").forEach((element) => {
    element.textContent = email || "";
    element.hidden = !email;
  });
  document.querySelectorAll(".avatar").forEach((element) => {
    element.textContent = avatarInitial(name || email);
  });
}

function toggleProfileMenu() {
  const shouldOpen = els.profileMenu?.hidden !== false;
  setProfileMenuOpen(shouldOpen);
}

function closeProfileMenu() {
  setProfileMenuOpen(false);
}

function setProfileMenuOpen(open) {
  if (!els.profileMenu || !els.profileMenuButton) return;
  els.profileMenu.hidden = !open;
  els.profileMenuButton.setAttribute("aria-expanded", String(open));
}

function applyTheme(theme, persist) {
  state.theme = theme;
  document.body.classList.toggle("theme-light", theme === "light");
  document.body.dataset.theme = theme;
  const nextLabel = theme === "light" ? "ダークモードに切り替え" : "ライトモードに切り替え";
  const nextIcon = theme === "light" ? iconMoon() : iconSun();
  [els.themeToggle, els.loginThemeToggle].forEach((button) => {
    if (!button) return;
    button.innerHTML = nextIcon;
    button.setAttribute("aria-label", nextLabel);
    button.setAttribute("title", nextLabel);
  });
  if (persist) {
    localStorage.setItem(themeStorageKey, theme);
  }
}

function startClock() {
  updateClock();
  window.setInterval(updateClock, 1000);
}

function updateClock() {
  const clock = formatTokyoClock(new Date());
  els.dateLabel.textContent = clock.date;
  els.timeLabel.textContent = `${clock.time} JST`;
  els.weatherLabel.textContent = state.weatherLabel;
}

function formatTokyoClock(date) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return {
    date: `${parts.month}/${parts.day}(${parts.weekday})`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

async function fetchTokyoWeather() {
  try {
    const url =
      "https://api.open-meteo.com/v1/forecast?latitude=35.6895&longitude=139.6917&current=temperature_2m,weather_code&timezone=Asia%2FTokyo";
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`weather: ${response.status}`);
    const payload = await response.json();
    const current = payload.current || {};
    const rawTemperature = Number(current.temperature_2m);
    if (!Number.isFinite(rawTemperature)) throw new Error("weather: missing temperature");
    const temperature = Math.round(rawTemperature);
    state.weatherLabel = `東京 ${temperature}℃ / ${weatherCodeLabel(current.weather_code)}`;
  } catch (error) {
    state.weatherLabel = "東京 --℃ / --";
    console.warn(error);
  }
  updateClock();
}

async function loadMonth(monthId) {
  const month = state.index.months.find((item) => item.id === monthId) || state.index.months[0];
  if (!month) {
    showNotice("対象月がありません");
    renderEmpty();
    return;
  }

  state.data = await fetchJson(month.path);
  state.overallSales = await fetchOptionalJson(`data/overall-sales-${month.id}.json`);
  state.overallBusinessSales = await fetchOptionalJson(`data/overall-business-sales-${month.id}.json`);
  state.expandedBusinessUnits = new Set();
  els.monthSelect.value = month.id;
  syncFilters();
  setView(state.view);
  render();
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path}: ${response.status}`);
  }
  return response.json();
}

async function fetchOptionalJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`${path}: ${response.status}`);
  }
  return response.json();
}

function populateMonthSelect() {
  els.monthSelect.innerHTML = state.index.months
    .map((month) => `<option value="${escapeHtml(month.id)}">${escapeHtml(month.label)}</option>`)
    .join("");
}

function syncFilters() {
  const records = state.data?.records || [];
  const dates = [...new Set(records.map((record) => record.date))].sort();
  const firstDate = dates[0] || "";
  const lastDate = dates.at(-1) || "";
  const today = formatTokyoDateInput(new Date());
  const defaultEndDate = today >= firstDate && today <= lastDate ? today : lastDate;
  const projects = [...new Set(records.map((record) => record.project).filter(Boolean))].sort(localeSort);
  const media = [...new Set(records.map((record) => record.media).filter(Boolean))].sort(localeSort);

  els.startDate.min = firstDate;
  els.startDate.max = lastDate;
  els.endDate.min = firstDate;
  els.endDate.max = lastDate;
  els.startDate.value = firstDate;
  els.endDate.value = defaultEndDate;

  els.projectSelect.innerHTML = [
    `<option value="all">全案件</option>`,
    ...projects.map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`),
  ].join("");

  els.mediaSelect.innerHTML = [
    `<option value="all">全媒体</option>`,
    ...media
      .filter((item) => item !== "全体")
      .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`),
  ].join("");
}

function setView(view) {
  const normalizedView = view === "overallBusiness" ? "overall" : view;
  state.view = ["mypage", "overall"].includes(normalizedView) ? normalizedView : "home";
  const titles = {
    home: "ホーム",
    mypage: "案件別日時",
    overall: "全体売上表",
  };
  els.pageTitle.textContent = titles[state.view];
  els.homeView.classList.toggle("active", state.view === "home");
  els.mypageView.classList.toggle("active", state.view === "mypage");
  els.overallView.classList.toggle("active", state.view === "overall");
  els.kpiGrid.hidden = state.view !== "home";
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === state.view);
  });
  renderSource();
  queueScrollProxyUpdate();
}

function render() {
  const records = getFilteredRecords();
  const baseRecords = selectBaseRecords(records);
  const totals = aggregate(baseRecords);

  renderSource();
  renderKpis(totals);
  renderChart(baseRecords);
  renderMediaBreakdown(records);
  renderProjectTop(baseRecords);
  renderSummary(totals);
  renderDetailTable(records);
  renderOverallSales();
  renderOverallBusinessSales();
}

function renderSource() {
  const source = state.data?.source || {};
  const generated = source.generatedAt ? new Date(source.generatedAt) : null;
  const generatedLabel = generated
    ? new Intl.DateTimeFormat("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(generated)
    : "--";

  els.sidebarUpdated.textContent = `最終更新 ${generatedLabel}`;
  els.sourceLabel.hidden = state.view === "home";
  els.sourceLabel.textContent =
    state.view === "home"
      ? ""
      : state.view === "overall"
        ? state.overallSales?.source?.sheetName || "◆全体売上表"
        : source.sheetName || "案件/媒体別日次_全体";

  if (source.mode === "sample") {
    showNotice("サンプルデータ表示中");
  } else {
    hideNotice();
  }
}

function renderKpis(totals) {
  if (state.view !== "home") {
    els.kpiGrid.hidden = true;
    els.kpiGrid.innerHTML = "";
    return;
  }
  els.kpiGrid.hidden = false;
  const primary = [
    { key: "sales", label: "売上", tone: "sales", format: formatYen },
    { key: "grossProfit", label: "粗利", tone: "profit", format: formatYen, signed: true },
    { key: "cost", label: "消化金額", tone: "cost", format: formatYen },
    { key: "roas", label: "ROAS", tone: "roas", format: formatPercent },
  ];
  const secondary = [
    { key: "cv", label: "CV", icon: "◎", format: formatNumber },
    { key: "cpa", label: "CPA", icon: "¥", format: formatYen },
  ];

  els.kpiGrid.innerHTML = `
    <section class="axad-summary" aria-label="主要指標">
      ${primary
        .map((metric) => {
          const value = totals[metric.key];
          return `
            <div class="axad-metric-row">
              <div class="axad-metric-label metric-${metric.tone}">${metric.label}</div>
              <div class="axad-metric-value">${metric.format(value, metric.signed)}</div>
            </div>
          `;
        })
        .join("")}
    </section>
    <section class="kpi-secondary" aria-label="補助指標">
      ${secondary
        .map(
          (metric) => `
            <article class="kpi-card">
              <div class="kpi-label">
                <span>${metric.label}</span>
                <span class="kpi-icon">${metric.icon}</span>
              </div>
              <div class="kpi-value">${metric.format(totals[metric.key])}</div>
            </article>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderChart(records) {
  els.chartMetricTabs.innerHTML = chartMetrics
    .map(
      (metric) =>
        `<button class="small-button ${state.chartMetric === metric.key ? "active" : ""}" type="button" data-metric="${metric.key}">${metric.label}</button>`,
    )
    .join("");

  els.chartMetricTabs.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.chartMetric = button.dataset.metric;
      render();
    });
  });

  const daily = groupBy(records, "date").map(([date, items]) => ({
    date,
    ...aggregate(items),
  }));
  const metric = metricDefinitions.find((item) => item.key === state.chartMetric);
  const max = Math.max(...daily.map((item) => Math.abs(item[state.chartMetric] || 0)), 1);

  if (!daily.length) {
    els.dailyChart.innerHTML = `<div class="empty-state">データなし</div>`;
    return;
  }

  els.dailyChart.innerHTML = daily
    .map((item) => {
      const rawValue = item[state.chartMetric] || 0;
      const height = Math.max(4, Math.round((Math.abs(rawValue) / max) * 210));
      return `
        <div class="bar-item">
          <div class="bar-value">${metric.format(rawValue)}</div>
          <div class="bar ${rawValue < 0 ? "negative-bar" : ""}" style="--bar-height:${height}px"></div>
          <div class="bar-label">${formatDay(item.date)}</div>
        </div>
      `;
    })
    .join("");
}

function renderMediaBreakdown(records) {
  const mediaRecords = records.filter((record) => record.media !== "全体");
  const source = mediaRecords.length ? mediaRecords : selectBaseRecords(records);
  const rows = groupBy(source, "media")
    .map(([name, items]) => ({ name, ...aggregate(items) }))
    .sort((a, b) => b.grossProfit - a.grossProfit)
    .slice(0, 8);
  renderRankRows(els.mediaBreakdown, rows, "grossProfit", { colorByName: mediaRankColorForName });
}

function renderProjectTop(records) {
  const rows = groupBy(records, "project")
    .map(([name, items]) => ({ name, ...aggregate(items) }))
    .sort((a, b) => b.grossProfit - a.grossProfit);
  renderRankRows(els.projectTop, rows, "grossProfit", { color: projectRankColor });
}

function renderRankRows(container, rows, key, options = {}) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">データなし</div>`;
    return;
  }
  const max = Math.max(...rows.map((row) => Math.abs(row[key] || 0)), 1);
  container.innerHTML = rows
    .map((row, index) => {
      const fill = Math.max(3, Math.round((Math.abs(row[key]) / max) * 100));
      const isNegative = row[key] < 0;
      const mappedColor = typeof options.colorByName === "function" ? options.colorByName(row.name) : null;
      const rankColor = options.color || mappedColor || (isNegative ? "#eb727a" : rankPalette[index % rankPalette.length]);
      const fillClass = isNegative && !options.color && !mappedColor ? "rank-negative" : "";
      return `
        <div class="rank-row" style="--rank-color:${rankColor}">
          <div class="rank-index">${index + 1}</div>
          <div class="rank-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</div>
          <div class="rank-value ${row[key] < 0 ? "negative" : "positive"}">${formatYen(row[key], true)}</div>
          <div class="rank-track"><div class="rank-fill ${fillClass}" style="--fill:${fill}%"></div></div>
        </div>
      `;
    })
    .join("");
}

function renderSummary(totals) {
  els.periodLabel.textContent = `${formatDateLabel(els.startDate.value)} - ${formatDateLabel(els.endDate.value)}`;
  els.summaryPanel.innerHTML = [
    ["売上", formatYen(totals.sales)],
    ["粗利", formatYen(totals.grossProfit, true)],
    ["消化金額", formatYen(totals.cost)],
    ["ROAS", formatPercent(totals.roas)],
    ["CV", formatNumber(totals.cv)],
    ["CPA", formatYen(totals.cpa)],
  ]
    .map(
      ([label, value]) => `
      <div class="summary-item">
        <div class="summary-label">${label}</div>
        <div class="summary-value">${value}</div>
      </div>
    `,
    )
    .join("");
}

function renderDetailTable(records) {
  const dates = [...new Set(records.map((record) => record.date))].sort();
  const projectGroups = groupByInOrder(records, "project").filter(([project]) => project !== "未設定");
  els.tableCount.textContent = `${projectGroups.length}案件 / ${dates.length}日`;
  els.sheetTableHead.innerHTML = "";

  if (!projectGroups.length || !dates.length) {
    els.detailTable.innerHTML = `<tr><td colspan="${dates.length + 2}" class="empty-state">データなし</td></tr>`;
    queueScrollProxyUpdate();
    return;
  }

  els.detailTable.innerHTML = projectGroups.map(([project, projectRecords]) => renderProjectBlock(project, projectRecords, dates)).join("");
  queueScrollProxyUpdate();
}

function renderOverallSales() {
  if (!els.overallSalesTable) return;

  const monthLabel = els.monthSelect.selectedOptions[0]?.textContent || "--";
  const sheet = state.overallSales;
  if (!sheet) {
    els.overallSheetMeta.textContent = `${monthLabel} / 全体売上表未反映`;
    els.overallSalesTable.innerHTML = `<div class="empty-state">この月の全体売上表は未反映です</div>`;
    queueScrollProxyUpdate();
    return;
  }

  const source = sheet.source || {};
  els.overallSheetMeta.textContent = `${monthLabel} / ${source.sheetName || "◆全体売上表"} 事業部別・卸・AXIS Fee`;
  const dataColumns = overallSalesColumns(sheet);
  const layout = overallLayoutConfig(sheet);
  const headerRows = renderOverallSalesHeader(sheet, dataColumns);
  const body = renderOverallSalesBody(sheet, dataColumns, layout);

  els.overallSalesTable.innerHTML = `
    <table class="overall-layout-table overall-sales-table" aria-label="全体売上表">
      <colgroup>
        <col class="overall-section-col">
        <col class="overall-metric-col">
        ${dataColumns.map(() => `<col class="overall-value-col">`).join("")}
      </colgroup>
      <thead>${headerRows}</thead>
      <tbody>${body}</tbody>
    </table>
  `;
  queueScrollProxyUpdate();
}

function renderOverallBusinessSales() {
  if (!els.overallBusinessTable) return;

  const monthLabel = els.monthSelect.selectedOptions[0]?.textContent || "--";
  const sheet = state.overallBusinessSales;
  if (!sheet) {
    renderBusinessColumnToggle(false);
    els.overallBusinessMeta.textContent = `${monthLabel} / 58行目以降未反映`;
    els.overallBusinessTable.innerHTML = `<div class="empty-state">この月の全体売上表は未反映です</div>`;
    queueScrollProxyUpdate();
    return;
  }
  renderBusinessColumnToggle(true);

  const source = sheet.source || {};
  const unitIndex = sheet.columns.findIndex((column) => column.key === "unit");
  const metricIndex = sheet.columns.findIndex((column) => column.key === "metric");
  const visibleColumns = businessVisibleColumns(sheet.columns);
  const stickyOffsets = businessStickyOffsets(visibleColumns);
  const mergeColumnIndexes = businessMergeColumnIndexes(sheet.columns, metricIndex);
  const visibleRows = sheet.rows.filter((row) => isBusinessVisibleRow(row, metricIndex));
  const headerCells = visibleColumns
    .map((column, index) => `<th class="${businessHeaderClass(column, index, stickyOffsets)}"${businessStickyStyle(stickyOffsets.get(index))}>${escapeHtml(column.label || "")}</th>`)
    .join("");
  const unitGroups = groupBusinessRowsByUnit(visibleRows, unitIndex);
  const bodyRows = unitGroups
    .map((group) => {
      const expanded = state.expandedBusinessUnits?.has(group.unit);
      const detailRows = expanded
        ? renderBusinessDetailRows(group.rows, visibleColumns, metricIndex, mergeColumnIndexes, stickyOffsets)
        : "";
      return `${renderBusinessUnitRow(group, visibleColumns.length, expanded)}${detailRows}`;
    })
    .join("");

  els.overallBusinessMeta.textContent = `${monthLabel} / ${source.sheetName || "◆全体売上表"} ${overallRangeLabel(source.range, "58行目以降")} / ${unitGroups.length.toLocaleString("ja-JP")} Unit / 表示 ${visibleRows.length.toLocaleString("ja-JP")}行`;
  els.overallBusinessTable.innerHTML = `
    <table class="overall-layout-table business-layout-table" aria-label="全体売上表 58行目以降">
      <colgroup>
        ${visibleColumns.map((column) => `<col style="width:${Number(column.width) || 104}px">`).join("")}
      </colgroup>
      <thead>
        <tr>${headerCells}</tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
  syncBusinessUnitBarOffset();
  queueScrollProxyUpdate();
}

function renderBusinessColumnToggle(hasSheet) {
  if (!els.overallBusinessColumnToggle) return;
  els.overallBusinessColumnToggle.hidden = !hasSheet;
  els.overallBusinessColumnToggle.textContent = state.showBusinessDetailColumns ? "詳細列を非表示" : "詳細列を表示";
  els.overallBusinessColumnToggle.setAttribute("aria-pressed", String(state.showBusinessDetailColumns));
  els.overallBusinessColumnToggle.classList.toggle("active", state.showBusinessDetailColumns);
  els.overallBusinessColumnToggle.title = "チーム / 案件 / 詳細 / クライアント";
}

function bindScrollProxies() {
  for (const { proxy, target } of scrollProxyPairs()) {
    if (!proxy || !target || proxy.dataset.bound === "true") continue;
    let syncing = false;
    proxy.addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      target.scrollLeft = proxy.scrollLeft;
      if (target === els.overallBusinessTable) syncBusinessUnitBarOffset();
      syncing = false;
    });
    target.addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      proxy.scrollLeft = target.scrollLeft;
      syncFloatingScrollFromTarget(target);
      if (target === els.overallBusinessTable) syncBusinessUnitBarOffset();
      syncing = false;
    });
    proxy.dataset.bound = "true";
  }
  els.floatingScrollProxy?.addEventListener("scroll", () => {
    const target = activeFloatingScrollTarget();
    if (!target || els.floatingScrollProxy.dataset.syncing === "true") return;
    els.floatingScrollProxy.dataset.syncing = "true";
    target.scrollLeft = els.floatingScrollProxy.scrollLeft;
    if (target === els.overallBusinessTable) syncBusinessUnitBarOffset();
    els.floatingScrollProxy.dataset.syncing = "false";
  });
  window.addEventListener("scroll", queueScrollProxyUpdate, { passive: true });
  window.addEventListener("resize", queueScrollProxyUpdate);
}

function queueScrollProxyUpdate() {
  window.requestAnimationFrame(updateScrollProxies);
}

function updateScrollProxies() {
  for (const { proxy, target } of scrollProxyPairs()) {
    if (!proxy || !target) continue;
    const inner = proxy.firstElementChild;
    if (!inner) continue;
    const scrollWidth = target.scrollWidth || 0;
    const clientWidth = target.clientWidth || 0;
    const needsProxy = scrollWidth > clientWidth + 1;
    proxy.hidden = !needsProxy;
    inner.style.width = `${scrollWidth}px`;
    proxy.scrollLeft = target.scrollLeft;
  }
  updateFloatingScrollProxy();
  syncBusinessUnitBarOffset();
}

function scrollProxyPairs() {
  return [
    { proxy: els.detailTableScrollProxy, target: els.detailTableWrap },
    { proxy: els.overallSalesScrollProxy, target: els.overallSalesTable },
    { proxy: els.overallBusinessScrollProxy, target: els.overallBusinessTable },
  ];
}

function updateFloatingScrollProxy() {
  const proxy = els.floatingScrollProxy;
  if (!proxy) return;
  const target = currentFloatingScrollTarget();
  const inner = proxy.firstElementChild;
  if (!target || !inner) {
    proxy.hidden = true;
    proxy.dataset.target = "";
    return;
  }
  proxy.hidden = false;
  proxy.dataset.target = target.id || "";
  inner.style.width = `${target.scrollWidth}px`;
  syncFloatingScrollFromTarget(target);
}

function currentFloatingScrollTarget() {
  const preferredTarget =
    state.view === "mypage"
      ? els.detailTableWrap
      : null;
  if (isFloatingScrollCandidate(preferredTarget)) return preferredTarget;
  return scrollProxyPairs()
    .map((pair) => pair.target)
    .filter(isFloatingScrollCandidate)
    .sort((a, b) => visibleHeight(b) - visibleHeight(a))[0] || null;
}

function activeFloatingScrollTarget() {
  const id = els.floatingScrollProxy?.dataset.target;
  const target = id ? document.getElementById(id) : null;
  return isFloatingScrollCandidate(target) ? target : currentFloatingScrollTarget();
}

function isFloatingScrollCandidate(target) {
  if (!target || target.scrollWidth <= target.clientWidth + 1) return false;
  const rect = target.getBoundingClientRect();
  return rect.bottom > 64 && rect.top < window.innerHeight;
}

function visibleHeight(target) {
  const rect = target.getBoundingClientRect();
  return Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 64));
}

function syncFloatingScrollFromTarget(target) {
  const proxy = els.floatingScrollProxy;
  if (!proxy || proxy.hidden || proxy.dataset.syncing === "true") return;
  if (proxy.dataset.target && proxy.dataset.target !== target.id) return;
  proxy.dataset.syncing = "true";
  proxy.scrollLeft = target.scrollLeft;
  proxy.dataset.syncing = "false";
}

function syncBusinessUnitBarOffset() {
  if (!els.overallBusinessTable) return;
  els.overallBusinessTable.style.setProperty("--business-unit-offset", `${els.overallBusinessTable.scrollLeft || 0}px`);
}

function isBusinessVisibleRow(row, metricIndex) {
  const metric = normalizeText(metricIndex >= 0 ? row.values[metricIndex] : "");
  return ["売上", "件数", "粗利", "利鞘"].includes(metric);
}

function groupBusinessRowsByUnit(rows, unitIndex) {
  const groups = new Map();
  for (const row of rows) {
    const unit = normalizeText(unitIndex >= 0 ? row.values[unitIndex] : "") || "未設定";
    if (!groups.has(unit)) groups.set(unit, { unit, rows: [] });
    groups.get(unit).rows.push(row);
  }
  return [...groups.values()];
}

function renderBusinessUnitRow(group, columnCount, expanded) {
  const rowCount = group.rows.length.toLocaleString("ja-JP");
  return `
    <tr class="business-unit-row">
      <td class="business-unit-cell" colspan="${columnCount}">
        <button class="business-unit-toggle" type="button" data-business-unit-toggle="${escapeAttribute(group.unit)}" aria-expanded="${expanded}">
          <span class="business-unit-caret" aria-hidden="true">${expanded ? "-" : "+"}</span>
          <span class="business-unit-name">${escapeHtml(group.unit)}</span>
          <span class="business-unit-count">${rowCount}行</span>
        </button>
      </td>
    </tr>
  `;
}

function renderBusinessDetailRows(rows, columns, metricIndex, mergeColumnIndexes, stickyOffsets) {
  return groupBusinessDetailRows(rows, mergeColumnIndexes)
    .map((group) =>
      group.rows
        .map((row, rowIndex) =>
          renderBusinessDetailRow(row, columns, metricIndex, mergeColumnIndexes, stickyOffsets, group.rows.length, rowIndex === 0),
        )
        .join(""),
    )
    .join("");
}

function groupBusinessDetailRows(rows, mergeColumnIndexes) {
  const groups = [];
  for (const row of rows) {
    const key = mergeColumnIndexes.map((index) => normalizeText(row.values[index])).join("\u001f");
    const current = groups[groups.length - 1];
    if (current && current.key === key) {
      current.rows.push(row);
    } else {
      groups.push({ key, rows: [row] });
    }
  }
  return groups;
}

function renderBusinessDetailRow(row, columns, metricIndex, mergeColumnIndexes, stickyOffsets, rowSpan, isFirstMergedRow) {
  const metric = metricIndex >= 0 ? row.values[metricIndex] : "";
  const mergeIndexes = new Set(mergeColumnIndexes);
  const cells = columns
    .map((column, index) => {
      const valueIndex = column.valueIndex;
      if (mergeIndexes.has(valueIndex) && !isFirstMergedRow) return "";
      const value = row.values[valueIndex];
      const background = businessCellBackground(row, valueIndex, column, metric);
      const stickyLeft = stickyOffsets.get(index);
      const className = businessCellClass(column, value, metric, {
        hasBackground: Boolean(background),
        isMerged: mergeIndexes.has(valueIndex) && rowSpan > 1,
        stickyIndex: stickyOffsets.has(index) ? index : null,
      });
      const style = businessCellStyle(background, stickyLeft);
      const rowSpanAttribute = mergeIndexes.has(valueIndex) && rowSpan > 1 ? ` rowspan="${rowSpan}"` : "";
      return `<td class="${className}"${rowSpanAttribute}${style}>${escapeHtml(formatBusinessValue(value, column, metric))}</td>`;
    })
    .join("");
  return `<tr class="business-detail-row">${cells}</tr>`;
}

function businessHeaderClass(column, index = -1, stickyOffsets = new Map()) {
  const classes = [];
  if (column.key === "metric") classes.push("business-metric-head");
  else if (column.key === "total" || column.type === "value") classes.push("business-value-head");
  else classes.push("business-meta-head");
  if (stickyOffsets.has(index)) classes.push("business-sticky-col", `business-sticky-col-${index + 1}`);
  return classes.join(" ");
}

function businessCellClass(column, value, metric, options = {}) {
  const classes = [];
  if (column.key === "metric") classes.push("business-metric-cell");
  if (column.key === "total" || column.type === "value") classes.push("business-value-cell");
  else classes.push("business-meta-cell");
  if (options.hasBackground) classes.push("business-filled-cell");
  if (options.isMerged) classes.push("business-merged-cell");
  if (Number.isInteger(options.stickyIndex)) classes.push("business-sticky-col", `business-sticky-col-${options.stickyIndex + 1}`);
  if (isBusinessNegative(value)) classes.push("overall-negative-value");
  if (normalizeText(metric) === "件数") classes.push("business-count-cell");
  return classes.join(" ");
}

function businessMergeColumnIndexes(columns, metricIndex) {
  return columns
    .map((column, index) => ({ column, index }))
    .filter(({ column, index }) => column.index >= 2 && column.index <= 10 && index !== metricIndex)
    .map(({ index }) => index);
}

function businessVisibleColumns(columns) {
  const hiddenColumnKeys = new Set(["team", "detail", "client"]);
  return columns
    .map((column, index) => ({ ...column, valueIndex: index }))
    .filter((column) => state.showBusinessDetailColumns || !hiddenColumnKeys.has(column.key));
}

function businessStickyOffsets(columns) {
  let left = 0;
  const offsets = new Map();
  const totalIndex = columns.findIndex((column) => column.key === "total" || normalizeText(column.label) === "合計");
  const stickyColumnCount = totalIndex >= 0 ? totalIndex + 1 : Math.min(5, columns.length);
  columns.slice(0, stickyColumnCount).forEach((column, index) => {
    offsets.set(index, left);
    left += Number(column.width) || 104;
  });
  return offsets;
}

function businessCellBackground(row, index, column, metric) {
  const metricBackground = businessMetricBackground(metric);
  if (metricBackground && column.index >= 2 && column.index <= 10) return metricBackground;

  const background = row.styles?.[index]?.background;
  if (typeof background !== "string") return "";
  const value = background.trim().toLowerCase();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(value) ? value : "";
}

function businessMetricBackground(metric) {
  const metricName = normalizeText(metric);
  if (metricName === "売上") return "#3d8fc2";
  if (metricName === "粗利" || metricName === "利鞘") return "#cfe8f7";
  if (metricName === "件数") return "#ffffff";
  return "";
}

function businessCellStyle(background, stickyLeft) {
  const styles = [];
  if (background) {
    styles.push(`--business-cell-bg:${background}`, `--business-cell-text:${readableTextColor(background)}`);
  }
  if (Number.isFinite(stickyLeft)) {
    styles.push(`--business-sticky-left:${stickyLeft}px`);
  }
  return styles.length ? ` style="${escapeAttribute(styles.join(";"))}"` : "";
}

function businessStickyStyle(stickyLeft) {
  if (!Number.isFinite(stickyLeft)) return "";
  return ` style="${escapeAttribute(`--business-sticky-left:${stickyLeft}px`)}"`;
}

function readableTextColor(background) {
  const color = expandHex(background);
  if (!color) return "#17212b";
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
  const luminance = 0.2126 * linearRgb(r) + 0.7152 * linearRgb(g) + 0.0722 * linearRgb(b);
  return luminance < 0.42 ? "#f8fbfd" : "#17212b";
}

function expandHex(color) {
  const value = color.replace("#", "");
  if (value.length === 3) {
    return value
      .split("")
      .map((character) => character + character)
      .join("");
  }
  return value.length === 6 ? value : "";
}

function linearRgb(value) {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function formatBusinessValue(value, column, metric) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    if (column.key === "total" || column.type === "value") {
      return normalizeText(metric) === "件数" ? formatNumber(value) : formatYen(value);
    }
    return Number.isInteger(value) ? String(value) : String(value);
  }
  return String(value);
}

function isBusinessNegative(value) {
  if (typeof value === "number") return value < 0;
  const text = normalizeText(value);
  return text.startsWith("-") || text.startsWith("¥-");
}

function overallSalesColumns(sheet) {
  const columnMap = new Map(sheet.columns.map((column) => [column.index, column]));
  const layout = overallLayoutConfig(sheet);
  const columnCount = 1 + daysInMonth(sheet.month);
  return Array.from({ length: columnCount }, (_, index) => index + layout.dataStartColumn)
    .filter((columnIndex) => columnMap.has(columnIndex))
    .map((columnIndex) => columnMap.get(columnIndex));
}

function overallLayoutConfig(sheet) {
  const row3 = overallRow(sheet, 3);
  const row4 = overallRow(sheet, 4);
  const row5 = overallRow(sheet, 5);
  const hasExplicitTotal = normalizeText(overallCell(row3, 11)?.text) === "Total";
  const hasMetricOnJ =
    ["売上", "粗利", "利鞘"].includes(normalizeText(overallCell(row4, 10)?.text)) ||
    ["売上", "粗利", "利鞘"].includes(normalizeText(overallCell(row5, 10)?.text));

  return {
    sectionColumn: 8,
    metricColumn: hasExplicitTotal || hasMetricOnJ ? 10 : 11,
    dataStartColumn: hasExplicitTotal || hasMetricOnJ ? 11 : 12,
  };
}

function daysInMonth(monthId) {
  const [year, month] = String(monthId || "")
    .split("-")
    .map((value) => Number(value));
  if (!Number.isInteger(year) || !Number.isInteger(month)) return 31;
  return new Date(year, month, 0).getDate();
}

function renderOverallSalesHeader(sheet, dataColumns) {
  const [year, month] = String(sheet.month || "")
    .split("-")
    .map((value) => Number(value));
  const topCells = dataColumns.map((_, index) => `<th class="overall-date-head">${escapeHtml(overallDateHead(year, month, index))}</th>`).join("");
  const weekdayCells = dataColumns
    .map((_, index) => `<th class="overall-weekday-head">${escapeHtml(overallWeekdayHead(year, month, index))}</th>`)
    .join("");

  return `
    <tr>
      <th class="overall-corner-head" colspan="2"></th>
      ${topCells}
    </tr>
    <tr>
      <th class="overall-corner-subhead" colspan="2"></th>
      ${weekdayCells}
    </tr>
  `;
}

function overallDateHead(year, month, index) {
  if (index === 0) return "Total";
  if (!Number.isInteger(year) || !Number.isInteger(month)) return "";
  return `${month}/${index}`;
}

function overallWeekdayHead(year, month, index) {
  if (index === 0 || !Number.isInteger(year) || !Number.isInteger(month)) return "";
  const weekday = ["日", "月", "火", "水", "木", "金", "土"];
  return weekday[new Date(year, month - 1, index).getDay()];
}

function renderOverallSalesBody(sheet, dataColumns, layout) {
  const sections = overallSections(sheet, layout);
  return sections
    .map((section, sectionIndex) => {
      const rows = range(section.start, section.end).map((rowIndex) => overallRow(sheet, rowIndex)).filter(Boolean);
      return rows
        .map((row, rowOffset) => {
          const sectionCell = rowOffset === 0 ? overallCell(row, layout.sectionColumn) : null;
          const metricCell = overallCell(row, layout.metricColumn);
          const sectionLabel =
            rowOffset === 0
              ? `<td class="overall-section-label" rowspan="${rows.length}"${overallStyleAttribute(sectionCell, { brightenText: true })}>${escapeHtml(
                  sectionCell?.text || "",
                )}</td>`
              : "";
          const values = dataColumns
            .map((column) => {
              const cell = overallCell(row, column.index);
              const valueClass = (cell?.text || "").startsWith("-") || (cell?.text || "").startsWith("¥-") ? " overall-negative-value" : "";
              return `<td class="overall-value-cell${valueClass}"${overallStyleAttribute(cell, { ignoreTextColor: true })}>${escapeHtml(cell?.text || "")}</td>`;
            })
            .join("");
          const spacerClass = rowOffset === 0 && sectionIndex > 0 ? " overall-section-start" : "";
          return `
            <tr class="overall-body-row${spacerClass}">
              ${sectionLabel}
              <td class="overall-metric-cell"${overallStyleAttribute(metricCell, { brightenText: true })}>${escapeHtml(metricCell?.text || "")}</td>
              ${values}
            </tr>
          `;
        })
        .join("");
    })
    .join("");
}

function overallSections(sheet, layout) {
  const candidates = sheet.rows
    .map((row) => {
      const label = normalizeText(overallCell(row, layout.sectionColumn)?.text);
      if (!label) return null;
      if (label.includes("事業部別 / 売上")) return { start: row.index, type: "sales" };
      if (label.includes("事業部別 / 粗利") || label.includes("事業部別 / 利鞘")) return { start: row.index, type: "gross" };
      if (label === "卸") return { start: row.index, type: "wholesale" };
      if (label.includes("AXIS Fee")) return { start: row.index, type: "axisFee" };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  if (candidates.length === 0) return [];

  return candidates
    .map((section, index) => {
      const next = candidates[index + 1];
      const rawEnd = next ? next.start - 1 : sheet.rows.at(-1)?.index || section.start;
      const stopRow = (!next || (section.type === "wholesale" && next?.type !== "axisFee")) ? overallLegacyStopRow(sheet, section.start) : null;
      const cappedEnd = stopRow ? Math.min(rawEnd, stopRow - 1) : rawEnd;
      const contiguousEnd = next ? cappedEnd : overallSectionEndBeforeGap(sheet, section.start, cappedEnd, layout);
      const end = trimOverallSectionEnd(sheet, section.start, contiguousEnd, layout);
      return { start: section.start, end: Math.max(section.start, end), type: section.type };
    })
    .filter((section) => section.end >= section.start);
}

function overallLegacyStopRow(sheet, startRow) {
  const markers = ["アクシス総合売上表", "KITEN総合売上表", "案件 / 正式名称"];
  const stop = sheet.rows
    .filter((row) => row.index > startRow)
    .find((row) =>
      row.cells?.some((cell) => {
        if (cell.skip) return false;
        const text = normalizeText(cell.text);
        return markers.some((marker) => text.includes(marker));
      }),
    );
  return stop?.index || null;
}

function overallSectionEndBeforeGap(sheet, startRow, endRow, layout) {
  let sawContent = false;
  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
    const hasContent = overallRowHasContent(overallRow(sheet, rowIndex), layout);
    if (hasContent) {
      sawContent = true;
      continue;
    }
    if (sawContent) return rowIndex - 1;
  }
  return endRow;
}

function trimOverallSectionEnd(sheet, startRow, endRow, layout) {
  for (let rowIndex = endRow; rowIndex > startRow; rowIndex -= 1) {
    const row = overallRow(sheet, rowIndex);
    if (overallRowHasContent(row, layout)) return rowIndex;
  }
  return startRow;
}

function overallRowHasContent(row, layout) {
  if (!row) return false;
  const metric = normalizeText(overallCell(row, layout.metricColumn)?.text);
  if (metric) return true;
  return row.cells?.some((cell) => {
    if (cell.skip) return false;
    const text = normalizeText(cell.text);
    if (!text) return false;
    const column = columnIndexFromAddress(cell.address);
    return column >= layout.dataStartColumn && column <= layout.dataStartColumn + daysInMonth(state.overallSales?.month);
  });
}

function overallRow(sheet, rowIndex) {
  return sheet.rows.find((row) => row.index === rowIndex) || null;
}

function overallCell(row, columnIndex) {
  if (!row) return null;
  return row.cells.find((cell) => !cell.skip && cell.address === `${columnLetter(columnIndex)}${row.index}`) || null;
}

function overallRangeLabel(range, fallback) {
  const start = String(range || "").split(":")[0];
  return start ? `${start}行目以降` : fallback;
}

function overallStyleAttribute(cell, options = {}) {
  if (!cell?.style) return "";
  const styles = cell.style
    .split(";")
    .map((style) => style.trim())
    .filter(Boolean)
    .filter((style) => {
      const property = style.split(":")[0]?.trim().toLowerCase();
      if (property === "background-color") return false;
      if (property?.startsWith("border")) return false;
      if (property === "font-family" || property === "font-size") return false;
      if (property === "text-align" || property === "vertical-align") return false;
      if (property === "color") {
        if (options.ignoreTextColor) return false;
        if (options.brightenText) return true;
        const value = style.split(":").slice(1).join(":").trim().toLowerCase();
        return !["#000000", "#434343", "#666666", "#efefef"].includes(value);
      }
      return true;
    })
    .map((style) => {
      if (!options.brightenText) return style;
      const property = style.split(":")[0]?.trim().toLowerCase();
      if (property !== "color") return style;
      const value = style.split(":").slice(1).join(":").trim().toLowerCase();
      return `--overall-dark-text:${brightOverallLabelColor(value)};--overall-light-text:${value}`;
    });
  return styles.length ? ` style="${escapeAttribute(styles.join(";"))}"` : "";
}

function brightOverallLabelColor(color) {
  const colors = {
    "#000000": "#f1f6fb",
    "#434343": "#f1f6fb",
    "#666666": "#f1f6fb",
    "#efefef": "#f1f6fb",
    "#f46524": "#ff9a68",
    "#334960": "#9cc7ee",
    "#990000": "#ff8585",
    "#144d60": "#7fd0e6",
    "#351c75": "#c9adff",
    "#ab2e6c": "#f18ac1",
    "#bf9000": "#e8cf73",
    "#6aa84f": "#9fda8f",
    "#274e13": "#8fd37a",
    "#3e5831": "#a6d697",
    "#cc0000": "#ff7d7d",
    "#0b5394": "#8dc6ff",
    "#0000ff": "#8ea8ff",
  };
  return colors[color] || color;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function emailName(email) {
  const localPart = normalizeText(email).split("@")[0] || "";
  return localPart || fallbackUser.name;
}

function avatarInitial(value) {
  const text = normalizeText(value);
  const first = Array.from(text).find((char) => /\S/.test(char));
  return first ? first.toUpperCase() : Array.from(fallbackUser.name)[0];
}

function columnIndexFromAddress(address) {
  const letters = String(address || "").match(/^[A-Z]+/)?.[0] || "";
  return [...letters].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0);
}

function columnLetter(columnIndex) {
  let dividend = columnIndex;
  let columnName = "";
  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    columnName = String.fromCharCode(65 + modulo) + columnName;
    dividend = Math.floor((dividend - modulo) / 26);
  }
  return columnName;
}

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function renderProjectBlock(project, projectRecords, dates) {
  const totalRecords = recordsForProjectTotal(projectRecords);
  const isOpen = state.expandedProjects.has(project);
  const mediaGroups = groupByInOrder(
    projectRecords.filter((record) => record.media !== "全体"),
    "media",
  );
  const button = `
    <button class="project-toggle" type="button" data-project-toggle="${escapeHtml(project)}" aria-expanded="${isOpen}">
      <span class="toggle-mark">${isOpen ? "▾" : "▸"}</span>
      <span>${escapeHtml(project)}</span>
    </button>
  `;
  const projectRows = renderSheetBlock({
    records: totalRecords,
    dates,
    labelCell: button,
    headClass: "project-head-row",
    rowClass: "project-value-row",
  });
  const mediaRows = isOpen
    ? mediaGroups.map(([media, mediaRecords]) => renderMediaBlock(media, mediaRecords, dates)).join("")
    : "";

  return `${projectRows}${mediaRows}<tr class="sheet-spacer-row"><td colspan="${dates.length + 2}"></td></tr>`;
}

function renderMediaBlock(media, records, dates) {
  const mediaColor = mediaRankColorForName(media);
  const mediaStyle = mediaColor ? ` style="${escapeAttribute(`--media-color:${mediaColor}`)}"` : "";
  const mediaLabel = `<span class="media-label ${mediaClassName(media)}"${mediaStyle}>${escapeHtml(media)}</span>`;
  return renderSheetBlock({
    records,
    dates,
    labelCell: mediaLabel,
    headClass: "media-head-row",
    rowClass: "media-value-row",
  });
}

function renderSheetBlock({ records, dates, labelCell, headClass, rowClass }) {
  const metrics = [
    { key: "sales", label: "売上", format: formatYen },
    { key: "grossProfit", label: "粗利", format: formatYen, valueClass: valueTone },
    { key: "cv", label: "件数", format: formatNumber },
    { key: "cost", label: "消化金額", format: formatYen },
    { key: "roas", label: "ROAS", format: formatPercent },
  ];
  const totals = aggregate(records);

  const head = `
    <tr class="sheet-block-head ${headClass}">
      <td class="sheet-name-cell">${labelCell}</td>
      <td class="sheet-total-head">合計</td>
      ${dates.map((date) => `<td class="sheet-date-head">${formatDateLabel(date)}</td>`).join("")}
    </tr>
  `;
  const rows = metrics
    .map((metric, index) => {
      const totalValue = metric.key === "roas" ? totals.roas : totals[metric.key];
      return `
        <tr class="${rowClass}">
          <td class="sheet-metric-name">${metric.label}</td>
          <td class="${metric.valueClass ? metric.valueClass(totalValue) : ""}">${metric.format(totalValue)}</td>
          ${dates.map((date) => renderDateMetricCell(records, date, metric)).join("")}
        </tr>
      `;
    })
    .join("");

  return head + rows;
}

function renderDateMetricCell(records, date, metric) {
  const daily = aggregate(records.filter((record) => record.date === date));
  const value = metric.key === "roas" ? daily.roas : daily[metric.key];
  return `<td class="${metric.valueClass ? metric.valueClass(value) : ""}">${metric.format(value)}</td>`;
}

function recordsForProjectTotal(projectRecords) {
  const totalRows = projectRecords.filter((record) => record.media === "全体");
  if (totalRows.length) return totalRows;
  return projectRecords.filter((record) => record.media !== "全体");
}

function mediaClassName(media) {
  const value = normalizeMediaName(media);
  if (value === "FB") return "media-fb";
  if (value === "YT") return "media-yt";
  if (value === "TIKTOK") return "media-tiktok";
  if (value === "PANGLE") return "media-pangle";
  if (value === "X") return "media-x";
  if (value === "LINE") return "media-line";
  return "media-other";
}

function mediaColorForName(media) {
  return mediaColorMap[normalizeMediaName(media)] || null;
}

function mediaRankColorForName(media) {
  return mediaRankColorMap[normalizeMediaName(media)] || null;
}

function normalizeMediaName(media) {
  const value = String(media || "").trim().toUpperCase();
  if (value === "FACEBOOK" || value === "META") return "FB";
  if (value === "YOUTUBE") return "YT";
  if (value === "LAP") return "LINE";
  return value;
}

function getFilteredRecords() {
  const records = state.data?.records || [];
  const start = els.startDate.value;
  const end = els.endDate.value;
  const project = els.projectSelect.value;
  const media = els.mediaSelect.value;

  return records.filter((record) => {
    if (start && record.date < start) return false;
    if (end && record.date > end) return false;
    if (project !== "all" && record.project !== project) return false;
    if (media !== "all" && record.media !== media) return false;
    return true;
  });
}

function selectBaseRecords(records) {
  if (els.mediaSelect.value !== "all") {
    return records;
  }
  const totalRows = records.filter((record) => record.media === "全体");
  return totalRows.length ? totalRows : records.filter((record) => record.media !== "全体");
}

function aggregate(records) {
  const totals = records.reduce(
    (acc, record) => {
      acc.sales += toNumber(record.sales);
      acc.grossProfit += toNumber(record.grossProfit);
      acc.cost += toNumber(record.cost);
      acc.cv += toNumber(record.cv);
      return acc;
    },
    { sales: 0, grossProfit: 0, cost: 0, cv: 0 },
  );
  totals.roas = totals.cost ? totals.sales / totals.cost : 0;
  totals.cpa = totals.cv ? totals.cost / totals.cv : 0;
  return totals;
}

function groupBy(items, keyOrGetter) {
  const getter = typeof keyOrGetter === "function" ? keyOrGetter : (item) => item[keyOrGetter];
  const map = new Map();
  for (const item of items) {
    const key = getter(item) || "未設定";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()].sort(([a], [b]) => localeSort(a, b));
}

function groupByInOrder(items, keyOrGetter) {
  const getter = typeof keyOrGetter === "function" ? keyOrGetter : (item) => item[keyOrGetter];
  const map = new Map();
  for (const item of items) {
    const key = getter(item) || "未設定";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()];
}

function formatYen(value, signed = false) {
  const number = Math.round(toNumber(value));
  if (number < 0) return `-¥${Math.abs(number).toLocaleString("ja-JP")}`;
  const prefix = signed && number > 0 ? "+" : "";
  return `${prefix}¥${number.toLocaleString("ja-JP")}`;
}

function formatNumber(value) {
  return Math.round(toNumber(value)).toLocaleString("ja-JP");
}

function formatPercent(value) {
  const number = toNumber(value);
  return `${(number * 100).toFixed(1)}%`;
}

function weatherCodeLabel(code) {
  const number = Number(code);
  if ([0].includes(number)) return "晴れ";
  if ([1].includes(number)) return "主に晴れ";
  if ([2].includes(number)) return "一部曇り";
  if ([3].includes(number)) return "曇り";
  if ([45, 48].includes(number)) return "霧";
  if ([51, 53, 55, 56, 57].includes(number)) return "小雨";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(number)) return "雨";
  if ([71, 73, 75, 77, 85, 86].includes(number)) return "雪";
  if ([95, 96, 99].includes(number)) return "雷雨";
  return "--";
}

function formatDay(date) {
  return `${Number(date.slice(8, 10))}日`;
}

function formatDateLabel(date) {
  if (!date) return "--";
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

function formatTokyoDateInput(date) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function valueTone(value) {
  const number = toNumber(value);
  if (number < 0) return "negative";
  if (number > 0) return "positive";
  return "";
}

function localeSort(a, b) {
  return String(a).localeCompare(String(b), "ja");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function showNotice(text) {
  els.notice.textContent = text;
  els.notice.hidden = false;
}

function hideNotice() {
  els.notice.hidden = true;
}

function iconSun() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.9 4.9 1.4 1.4" />
      <path d="m17.7 17.7 1.4 1.4" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m4.9 19.1 1.4-1.4" />
      <path d="m17.7 6.3 1.4-1.4" />
    </svg>
  `;
}

function iconMoon() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M20.4 14.5A7.7 7.7 0 0 1 9.5 3.6 8.6 8.6 0 1 0 20.4 14.5Z" />
    </svg>
  `;
}

function renderEmpty() {
  els.kpiGrid.innerHTML = "";
  els.dailyChart.innerHTML = `<div class="empty-state">データなし</div>`;
  els.mediaBreakdown.innerHTML = `<div class="empty-state">データなし</div>`;
  els.projectTop.innerHTML = `<div class="empty-state">データなし</div>`;
  els.summaryPanel.innerHTML = "";
  els.detailTable.innerHTML = `<tr><td colspan="8" class="empty-state">データなし</td></tr>`;
  if (els.overallSalesTable) {
    els.overallSalesTable.innerHTML = `<div class="empty-state">データなし</div>`;
  }
  if (els.overallBusinessTable) {
    els.overallBusinessTable.innerHTML = `<div class="empty-state">データなし</div>`;
  }
}

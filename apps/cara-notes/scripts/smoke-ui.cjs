const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const appUrl = process.env.CARA_NOTES_URL || "http://127.0.0.1:4536/";
const outDir = path.resolve(__dirname, "..", "..", "..", "resources", "cara-analysis", "design", "exports");

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });

  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      errors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await page.addInitScript(() => localStorage.clear());
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.waitForSelector(".bn-editor");
  await page.waitForFunction(() => document.body.innerText.includes("Story DB"));
  const originalStoryPages = await page.evaluate(async () => {
    const response = await fetch("/api/story/pages");
    const payload = await response.json();
    return payload.pages;
  });

  const initialTitle = await page.locator("textarea[aria-label='Page title']").inputValue();
  const storageStatus = await page.locator(".topbar-meta .label-text").textContent();
  const pageLinks = await page.locator(".page-link span").allTextContents();
  const hasStoryChapters = pageLinks.includes("Anam Cara") && pageLinks.includes("After the Quiet");
  const hasReportPages = ["Daily Notes", "Rhythm", "Boundaries", "Anchors"].some((title) => pageLinks.includes(title));
  const checkboxCount = await page.locator("input[type='checkbox']").count();
  const subtitleInputCount = await page.locator("input[aria-label='Page description']").count();
  const coverImageCount = await page.locator(".cover-image").count();
  const coverCreditText = await page.locator(".cover-credit").textContent();
  const lightCoverEdgeFade = await page.evaluate(() => getComputedStyle(document.querySelector(".doc-cover"), "::after").backgroundImage);
  const processAreaCount = await page.locator(".process-area").count();
  const storyScrollAuto = await page.evaluate(() => {
    const docScroll = document.querySelector(".doc-scroll");
    return Boolean(docScroll && getComputedStyle(docScroll).overflowY === "auto");
  });
  const customScrollbar = await page.evaluate(() => {
    const docScroll = document.querySelector(".doc-scroll");
    if (!docScroll) return "";
    return getComputedStyle(docScroll).scrollbarColor;
  });
  const settingsButtonBesideNewPage = await page.evaluate(() => {
    const newPage = document.querySelector(".new-page-button")?.getBoundingClientRect();
    const settings = document.querySelector(".settings-button")?.getBoundingClientRect();
    if (!newPage || !settings) return false;
    return settings.left >= newPage.right - 1 && Math.abs(settings.top - newPage.top) <= 2;
  });
  await page.waitForFunction(() => !document.querySelector(".doc-cover.loading"));
  await page.screenshot({ path: path.join(outDir, "cara-notes-light.png"), fullPage: true });

  const switchTimes = [];
  const coverSwitchStates = [];
  for (const title of ["Before April", "When She Came Back", "Anam Cara", "The Room We Kept"]) {
    const expectedPage = originalStoryPages.find((pageEntry) => pageEntry.title === title);
    const expectedPosition = `${Number(expectedPage?.cover?.position?.x ?? 50)}% ${Number(expectedPage?.cover?.position?.y ?? 50)}%`;
    const beforeCover = await page.locator(".cover-image").evaluateHandle((node) => node);
    const beforeCoverSrc = await page.locator(".cover-image").getAttribute("src");
    const started = Date.now();
    await page.getByRole("button", { name: title }).click();
    await page.waitForFunction(({ expectedTitle, expectedPageId }) => {
      const image = document.querySelector(".cover-image");
      return (
        document.querySelector("textarea[aria-label='Page title']")?.value === expectedTitle &&
        document.querySelectorAll(".bn-editor").length === 1 &&
        document.querySelectorAll(".cover-image").length === 1 &&
        image?.dataset.coverKey?.startsWith(`${expectedPageId}:`)
      );
    }, { expectedTitle: title, expectedPageId: expectedPage?.id });
    const nodeReused = await page.evaluate(
      (previousNode) => previousNode === document.querySelector(".cover-image"),
      beforeCover,
    );
    const afterCoverSrc = await page.locator(".cover-image").getAttribute("src");
    const afterCoverKey = await page.locator(".cover-image").getAttribute("data-cover-key");
    const afterCoverPosition = await page.locator(".cover-image").evaluate((node) => getComputedStyle(node).objectPosition);
    await beforeCover.dispose();
    coverSwitchStates.push({
      title,
      nodeReused,
      srcChanged: beforeCoverSrc !== afterCoverSrc,
      coverKey: afterCoverKey,
      pageMatched: afterCoverKey?.startsWith(`${expectedPage?.id}:`) ?? false,
      positionMatched: afterCoverPosition === expectedPosition,
      afterCoverPosition,
      expectedPosition,
    });
    switchTimes.push(Date.now() - started);
  }
  const maxSwitchMs = Math.max(...switchTimes);

  const originalCoverPosition = await page.locator(".cover-image").evaluate((node) => getComputedStyle(node).objectPosition);
  await page.getByLabel("Reposition cover").click();
  await page.waitForSelector(".reposition-modal");
  await page.getByLabel("Vertical position").evaluate((node) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(node, "64");
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const livePreviewPosition = await page.locator(".position-preview img").evaluate((node) => getComputedStyle(node).objectPosition);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const cancelRestoredPosition = await page.locator(".cover-image").evaluate((node) => getComputedStyle(node).objectPosition);

  await page.getByLabel("Change cover").click();
  await page.waitForSelector(".cover-modal");
  await page.waitForSelector(".cover-result");
  await page.locator(".cover-result").first().click();
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForSelector(".reposition-modal");
  await page.getByLabel("Vertical position").evaluate((node) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(node, "58");
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForSelector(".reposition-modal", { state: "detached" });
  await page.waitForFunction(() => localStorage.getItem("cara-notes:notebook:v1")?.includes('"cover"'));
  const savedCoverPosition = await page.locator(".cover-image").evaluate((node) => getComputedStyle(node).objectPosition);

  await page.getByLabel("Open settings").click();
  await page.waitForSelector(".settings-scroll");
  const settingsTitle = await page.locator(".settings-heading h1").textContent();
  const settingsHasProcessStatus = await page.locator(".settings-section-title", { hasText: "Process Status" }).count();
  const settingsScrollAuto = await page.evaluate(() => {
    const settingsScroll = document.querySelector(".settings-scroll");
    const docScroll = document.querySelector(".doc-scroll");
    return Boolean(settingsScroll && !docScroll && getComputedStyle(settingsScroll).overflowY === "auto");
  });
  await page.screenshot({ path: path.join(outDir, "cara-notes-settings-light.png"), fullPage: true });
  await page.getByRole("button", { name: /The Room We Kept/ }).click();
  await page.waitForSelector("textarea[aria-label='Page title']");

  await page.getByLabel("Switch to dark mode").click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const savedTheme = await page.evaluate(() => localStorage.getItem("cara-notes:theme:v1"));
  const darkCoverEdgeFade = await page.evaluate(() => getComputedStyle(document.querySelector(".doc-cover"), "::after").backgroundImage);
  await page.screenshot({ path: path.join(outDir, "cara-notes-dark.png"), fullPage: true });

  await page.locator("textarea[aria-label='Page title']").fill("The Room Journal");
  await page.waitForFunction(() => localStorage.getItem("cara-notes:notebook:v1")?.includes("The Room Journal"));
  const editedNavTitle = await page.locator(".page-link.active span").textContent();

  await page.getByRole("button", { name: "New page" }).click();
  await page.locator("textarea[aria-label='Page title']").fill("Night Draft");
  await page.waitForFunction(() => localStorage.getItem("cara-notes:notebook:v1")?.includes("Night Draft"));
  const draftVisible = await page.locator(".page-link span", { hasText: "Night Draft" }).count();

  await page.getByRole("button", { name: "Hide notebook" }).click();
  const sidebarClosed = await page.locator(".app-shell.sidebar-closed").count();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      errors.push(`mobile ${message.type()}: ${message.text()}`);
    }
  });
  mobile.on("pageerror", (error) => errors.push(`mobile pageerror: ${error.message}`));
  await mobile.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cara-notes:theme:v1", "dark");
  });
  await mobile.goto(appUrl, { waitUntil: "networkidle" });
  await mobile.waitForSelector(".bn-editor");
  await mobile.getByRole("button", { name: "Hide notebook" }).click();
  await mobile.waitForTimeout(250);
  const mobileSidebarClosed = await mobile.locator(".app-shell.sidebar-closed").count();
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const mobileTopbarTop = await mobile.evaluate(() => (
    Math.round(document.querySelector(".topbar").getBoundingClientRect().top)
  ));
  await mobile.screenshot({ path: path.join(outDir, "cara-notes-mobile-dark.png") });

  await page.evaluate(async (pages) => {
    await fetch("/api/story/pages", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pages }),
    });
  }, originalStoryPages);

  await browser.close();

  const result = {
    ok:
      errors.length === 0 &&
      !overflow &&
      initialTitle === "The Room We Kept" &&
      storageStatus.includes("Story DB") &&
      hasStoryChapters &&
      !hasReportPages &&
      checkboxCount === 0 &&
      subtitleInputCount === 0 &&
      coverImageCount === 1 &&
      coverCreditText?.includes("Unsplash") &&
      lightCoverEdgeFade.includes("linear-gradient") &&
      darkCoverEdgeFade.includes("linear-gradient") &&
      lightCoverEdgeFade !== darkCoverEdgeFade &&
      coverSwitchStates.every((state) => !state.nodeReused && state.pageMatched && state.positionMatched) &&
      processAreaCount === 0 &&
      maxSwitchMs < 1200 &&
      storyScrollAuto &&
      customScrollbar !== "auto" &&
      livePreviewPosition !== originalCoverPosition &&
      cancelRestoredPosition === originalCoverPosition &&
      savedCoverPosition.includes("58%") &&
      settingsButtonBesideNewPage &&
      settingsTitle === "Settings" &&
      settingsHasProcessStatus > 0 &&
      settingsScrollAuto &&
      savedTheme === "dark" &&
      editedNavTitle === "The Room Journal" &&
      draftVisible > 0 &&
      sidebarClosed === 1 &&
      mobileSidebarClosed === 1 &&
      mobileTopbarTop === 0,
    initialTitle,
    storageStatus,
    pageCount: pageLinks.length,
    hasStoryChapters,
    hasReportPages,
    checkboxCount,
    subtitleInputCount,
    coverImageCount,
    coverCreditText,
    lightCoverEdgeFade,
    darkCoverEdgeFade,
    switchTimes,
    maxSwitchMs,
    coverSwitchStates,
    processAreaCount,
    storyScrollAuto,
    customScrollbar,
    originalCoverPosition,
    livePreviewPosition,
    cancelRestoredPosition,
    savedCoverPosition,
    settingsButtonBesideNewPage,
    settingsTitle,
    settingsHasProcessStatus,
    settingsScrollAuto,
    hasProcessPage: pageLinks.includes("Process"),
    savedTheme,
    editedNavTitle,
    draftVisible,
    sidebarClosed,
    mobileSidebarClosed,
    mobileTopbarTop,
    overflow,
    errors,
    screenshots: [
      "resources/cara-analysis/design/exports/cara-notes-light.png",
      "resources/cara-analysis/design/exports/cara-notes-settings-light.png",
      "resources/cara-analysis/design/exports/cara-notes-dark.png",
      "resources/cara-analysis/design/exports/cara-notes-mobile-dark.png",
    ],
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

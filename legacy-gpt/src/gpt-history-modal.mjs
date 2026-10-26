/**
 * Close ONLY confirmed ChatGPT conversation-history throttling dialogs.
 * Passive UI automation: no direct requests, no reloads, no auto re-sends,
 * no bypass of real ChatGPT rate limits.
 */
const busy = new WeakSet();
const lastReports = new WeakMap();
const lastDismissals = new WeakMap();
const watchers = new WeakMap();
const HISTORY_TITLE = /too\s+many\s+requests|יותר\s+מדי\s+בקשות/i;
const HISTORY_BODY = /temporarily\s+limited\s+access\s+to\s+your\s+conversations|making\s+requests\s+too\s+quickly|access\s+to\s+your\s+conversations|conversation\s+history\s+(?:is\s+)?(?:temporarily\s+)?(?:limited|unavailable)|גישה\s+לשיחות|הגישה\s+לשיחות|בקשות\s+מהר\s+מדי/i;
const SELECTORS=[
  'button[aria-label="Close" i]',
  'button[aria-label="Dismiss" i]',
  'button[aria-label="Close dialog" i]',
  'button[aria-label="סגור"]',
  'button[title="Close" i]',
  'button[title="Dismiss" i]',
  'button[data-testid*="close" i]',
  '[data-slot="dialog-close"]',
  'button:has(svg.lucide-x)',
  'button:has(svg[data-lucide="x"])',
  'button:has(svg path[d^="M18 6"])',
  '[aria-label="Close" i][role="button"]',
];

export function isConversationHistoryLimitDialog(text) {
  return typeof text==='string' && text.length<9000 &&
    HISTORY_TITLE.test(text) && HISTORY_BODY.test(text);
}
function log(page, state) {
  const prev=lastReports.get(page),now=Date.now();
  if(prev?.state===state && now-prev.time<60000)return;
  lastReports.set(page,{state,time:now});
  console.info('[GPT-HISTORY-MODAL]',JSON.stringify({state}));
}
async function findHistoryDialog(page) {
  const roots=page.locator('[role="alertdialog"], [role="dialog"], [data-slot="dialog-content"], [data-radix-dialog-content]');
  const total=Math.min(10,await roots.count().catch(()=>0));
  for(let i=0;i<total;i++) {
    const root=roots.nth(i);
    if(!await root.isVisible().catch(()=>false))continue;
    const text=await root.innerText({timeout:450}).catch(()=>'');
    if(isConversationHistoryLimitDialog(text))return root;
  }
  // The new UI sometimes uses a portal without role=dialog. Search strictly
  // around the visible history-related warning, not unrelated rate notices.
  const titles=page.getByText(HISTORY_TITLE);
  let visibleRateTitle=false;
  const n=Math.min(4,await titles.count().catch(()=>0));
  for(let i=0;i<n;i++){
    const title=titles.nth(i);
    if(!await title.isVisible().catch(()=>false))continue;
    visibleRateTitle=true;
    let parent=title;
    for(let level=0;level<7;level++) {
      parent=parent.locator('xpath=..');
      const text=await parent.innerText({timeout:450}).catch(()=>'');
      if(!isConversationHistoryLimitDialog(text) || text.length>1700)continue;
      // Prefer a container with a close control, rather than a tiny paragraph.
      for(const selector of SELECTORS) {
        const b=parent.locator(selector).first();
        if(await b.isVisible().catch(()=>false))return parent;
      }
      // Keep the first recognized container for possible Escape.
      if(level>=4)return parent;
    }
  }
  if(visibleRateTitle) log(page,'rate_limit_title_visible_unclassified');
  return null;
}

/** First/negative checks are NEVER throttled: a modal can appear milliseconds
 * after a previous no-op check. Only a successful dismissal gets a short guard. */
export async function dismissChatHistoryRateLimitDialog(page) {
  if(!page || busy.has(page))return false;
  try {
    if(page.isClosed() || new URL(page.url()).origin!=='https://chatgpt.com')return false;
  }catch{return false;}
  if(Date.now()-(lastDismissals.get(page)||0)<700)return false;
  busy.add(page);
  try {
    const dialog=await findHistoryDialog(page);
    if(!dialog)return false;
    log(page,'history_dialog_detected');
    for(const selector of SELECTORS) {
      const control=dialog.locator(selector).first();
      if(!await control.isVisible().catch(()=>false))continue;
      if(!await control.isEnabled().catch(()=>false))continue;
      try {
        await control.click({timeout:900});
        if(!await dialog.isVisible().catch(()=>false)) {
          lastDismissals.set(page,Date.now());
          log(page,'dismissed_by_close_button');
          return true;
        }
      }catch{/* overlay transitions can invalidate a selector */}
    }
    const role=await dialog.getAttribute('role').catch(()=>null);
    const ariaModal=await dialog.getAttribute('aria-modal').catch(()=>null);
    if(role==='dialog'||role==='alertdialog'||ariaModal==='true') {
      try {
        await page.keyboard.press('Escape');
        if(!await dialog.isVisible().catch(()=>false)) {
          lastDismissals.set(page,Date.now());
          log(page,'dismissed_by_escape');
          return true;
        }
      }catch{}
    }
    log(page,'detected_but_not_dismissed');
    return false;
  }catch{return false;}
  finally {busy.delete(page);}
}

/**
 * Observe the existing browser tab while a turn is in progress. Unlike the
 * old pre-send check, this catches overlays that arrive DURING Playwright's
 * auto-wait for the editor or Send button. Only one watcher per page.
 */
export function startChatHistoryModalWatcher(page,{intervalMs=450}={}) {
  if(!page)return ()=>{};
  const existing=watchers.get(page);
  if(existing)return existing.stop;
  let active=true,timer=null,running=false;
  const stop=()=>{
    if(!active)return;
    active=false;
    if(timer)clearTimeout(timer);
    watchers.delete(page);
    try{page.off?.('close',stop);}catch{}
  };
  const tick=async()=>{
    if(!active||running)return;
    running=true;
    try {
      if(page.isClosed()){stop();return;}
      await dismissChatHistoryRateLimitDialog(page);
    }catch{}
    finally {
      running=false;
      if(active){
        timer=setTimeout(tick,intervalMs);
        timer.unref?.();
      }
    }
  };
  watchers.set(page,{stop});
  try{page.on?.('close',stop);}catch{}
  void tick();
  return stop;
}

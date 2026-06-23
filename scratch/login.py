from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.chromium.launch(channel="chrome", headless=True)
    ctx=b.new_context(viewport={"width":1200,"height":760})
    pg=ctx.new_page()
    errs=[]
    pg.on("requestfailed", lambda r: errs.append(("FAILED", r.url)))
    pg.on("response", lambda r: errs.append((r.status, r.url)) if ('logo' in r.url or 'hero' in r.url) else None)
    pg.goto("http://localhost:5173/", wait_until="networkidle", timeout=60000); pg.wait_for_timeout(2000)
    # On the chooser, click the AR Dashboard option
    try:
        pg.get_by_text("AR Dashboard", exact=False).first.click(); pg.wait_for_timeout(2000)
    except Exception as e:
        print("chooser click:", e)
    pg.screenshot(path="d:/AR Joey/AR Joey/scratch/login.png")
    # check the brand-logo img
    img = pg.locator("img.brand-logo")
    if img.count():
        nat = img.first.evaluate("e => ({src:e.currentSrc, w:e.naturalWidth, h:e.naturalHeight})")
        print("brand-logo:", nat)
    for s,u in errs:
        if 'logo' in str(u) or 'hero' in str(u): print(s, u)
    b.close()

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.chromium.launch(channel="chrome", headless=True)
    ctx=b.new_context(viewport={"width":1500,"height":1000})
    ctx.add_init_script("sessionStorage.setItem('lt_auth_ok','1'); sessionStorage.setItem('lt_role','full');")
    pg=ctx.new_page()
    pg.goto("http://localhost:5173/", wait_until="networkidle", timeout=60000); pg.wait_for_timeout(5000)
    pg.get_by_text("Little Tree Accounts receivable", exact=False).first.click(); pg.wait_for_timeout(3500)
    print("LT Action List first header:", pg.locator(".table-card .data-table thead th").first.inner_text())
    b.close()

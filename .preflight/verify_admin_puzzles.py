from playwright.sync_api import sync_playwright
import json, urllib.request

# 1. 通过 API 获取管理员 token
login_data = json.dumps({"account": "admin", "password": "admin123"}).encode()
req = urllib.request.Request(
    "http://localhost:3000/api/admin/login",
    data=login_data,
    headers={"Content-Type": "application/json"},
    method="POST",
)
resp = urllib.request.urlopen(req)
login_resp = json.loads(resp.read())
token = login_resp["token"]
admin_info = login_resp["admin"]
print("[verify] 获取到 admin token:", token[:30] + "...")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context()
    page = context.new_page()

    # 收集 console 日志
    logs = []
    page.on("console", lambda msg: logs.append(f"[{msg.type}] {msg.text}"))
    page.on("pageerror", lambda err: logs.append(f"[pageerror] {err}"))

    # 2. 先打开页面以设置 localStorage
    page.goto("http://localhost:8080/pages/admin-puzzles.html")
    page.wait_for_load_state("networkidle")

    # 注入 admin token
    page.evaluate(
        """([token, info]) => {
            localStorage.setItem('ts_admin_token', token);
            localStorage.setItem('ts_admin_info', JSON.stringify(info));
        }""",
        [token, admin_info],
    )

    # 3. 重新加载以应用 token
    page.reload()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1500)  # 等待 API 请求完成

    # 4. 验证统计卡片已填充（不再是 "—"）
    stat_total = page.text_content("#stat-total")
    stat_online = page.text_content("#stat-online")
    stat_pending = page.text_content("#stat-pending")
    stat_offline = page.text_content("#stat-offline")
    print(f"[verify] 统计: total={stat_total}, online={stat_online}, pending={stat_pending}, offline={stat_offline}")

    # 5. 验证表格已渲染行
    rows = page.locator("#puzzle-table-body tr")
    row_count = rows.count()
    print(f"[verify] 表格行数: {row_count}")

    # 6. 验证分页信息
    pagination_info = page.text_content("#pagination-info")
    print(f"[verify] 分页信息: {pagination_info}")

    # 7. 验证管理员信息已渲染
    admin_name = page.text_content("#admin-name")
    admin_role = page.text_content("#admin-role")
    print(f"[verify] 管理员: name={admin_name}, role={admin_role}")

    # 8. 截图（完整页面）
    page.screenshot(path="/workspace/.preflight/admin-puzzles-loaded.png", full_page=True)
    print("[verify] 已保存截图: /workspace/.preflight/admin-puzzles-loaded.png")

    # 9. 测试筛选 - 选择"困难"难度
    page.select_option("#filter-difficulty", "hard")
    page.wait_for_timeout(1200)
    rows_after_filter = page.locator("#puzzle-table-body tr").count()
    pagination_after_filter = page.text_content("#pagination-info")
    print(f"[verify] 筛选困难后: 行数={rows_after_filter}, 分页={pagination_after_filter}")

    # 10. 测试搜索
    page.fill("#search-input", "海龟")
    page.wait_for_timeout(800)
    rows_after_search = page.locator("#puzzle-table-body tr").count()
    pagination_after_search = page.text_content("#pagination-info")
    print(f"[verify] 搜索'海龟'后: 行数={rows_after_search}, 分页={pagination_after_search}")
    page.screenshot(path="/workspace/.preflight/admin-puzzles-filtered.png", full_page=True)
    print("[verify] 已保存筛选截图: /workspace/.preflight/admin-puzzles-filtered.png")

    # 11. 清除筛选，测试打开"添加新题"面板
    page.fill("#search-input", "")
    page.select_option("#filter-difficulty", "all")
    page.wait_for_timeout(800)
    page.click("#btn-add")
    page.wait_for_timeout(500)
    panel_title = page.text_content("#edit-panel-title")
    panel_open = page.locator("#edit-panel").get_attribute("class")
    print(f"[verify] 编辑面板标题: {panel_title}")
    print(f"[verify] 面板 class: {panel_open}")
    page.screenshot(path="/workspace/.preflight/admin-puzzles-add-panel.png", full_page=True)
    print("[verify] 已保存新增面板截图: /workspace/.preflight/admin-puzzles-add-panel.png")

    # 12. 关闭面板
    page.click("#btn-close-panel")
    page.wait_for_timeout(500)

    # 13. 打印 console 日志
    print("\n[verify] 浏览器 console 日志:")
    for log in logs:
        print("  " + log)

    browser.close()
    print("\n[verify] 验证完成")

// 渲染辅助工具
(function () {
  const Helpers = {
    // 格式化为 "x分钟前" / "x小时前" / "x天前"
    formatTimeAgo(dateStr) {
      if (!dateStr) return '';
      const d = new Date(dateStr.replace(' ', 'T'));
      const diff = Date.now() - d.getTime();
      if (diff < 0) return '刚刚';
      const sec = Math.floor(diff / 1000);
      if (sec < 60) return '刚刚';
      const min = Math.floor(sec / 60);
      if (min < 60) return min + ' 分钟前';
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + ' 小时前';
      const day = Math.floor(hr / 24);
      if (day < 30) return day + ' 天前';
      return d.toLocaleDateString('zh-CN');
    },

    // 格式化秒数为 mm:ss
    formatDuration(sec) {
      if (sec == null || isNaN(sec)) return '--:--';
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    },

    // 从 HTML 字符串创建 DOM 元素
    el(html) {
      const template = document.createElement('template');
      template.innerHTML = html.trim();
      return template.content.firstElementChild;
    },

    // 难度映射
    difficultyLabel(d) {
      return { easy: '简单', medium: '中等', hard: '困难' }[d] || d;
    },

    difficultyClass(d) {
      return {
        easy: 'bg-emerald-100 text-emerald-700',
        medium: 'bg-amber-100 text-amber-700',
        hard: 'bg-rose-100 text-rose-700',
      }[d] || 'bg-stone-100 text-stone-700';
    },

    statusLabel(s) {
      return { online: '已上线', pending: '待审核', offline: '已下架' }[s] || s;
    },

    statusClass(s) {
      return {
        online: 'bg-emerald-100 text-emerald-700',
        pending: 'bg-amber-100 text-amber-700',
        offline: 'bg-stone-200 text-stone-600',
      }[s] || 'bg-stone-100 text-stone-700';
    },

    judgmentConfig(j) {
      return {
        yes: { label: '是', color: 'text-emerald-600', bg: 'bg-emerald-50', icon: 'check-circle' },
        no: { label: '不是', color: 'text-rose-600', bg: 'bg-rose-50', icon: 'x-circle' },
        irrelevant: { label: '无关', color: 'text-amber-600', bg: 'bg-amber-50', icon: 'minus-circle' },
      }[j] || { label: j, color: 'text-stone-600', bg: 'bg-stone-50', icon: 'circle' };
    },

    // 转义 HTML 防注入
    escape(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    // 显示 toast 提示（简易）
    toast(message, type = 'info') {
      const colors = {
        info: 'bg-stone-800/90 text-white',
        success: 'bg-emerald-600/90 text-white',
        error: 'bg-rose-600/90 text-white',
        warn: 'bg-amber-600/90 text-white',
      };
      const node = Helpers.el(
        `<div class="fixed top-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-2xl text-sm shadow-lg backdrop-blur-md ${colors[type] || colors.info} transition-all opacity-0 -translate-y-2">
          ${Helpers.escape(message)}
        </div>`
      );
      document.body.appendChild(node);
      requestAnimationFrame(() => {
        node.classList.remove('opacity-0', '-translate-y-2');
      });
      setTimeout(() => {
        node.classList.add('opacity-0', '-translate-y-2');
        setTimeout(() => node.remove(), 300);
      }, 2600);
    },

    // 重新初始化 Lucide 图标
    refreshIcons() {
      if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
      }
    },
  };

  window.Helpers = Helpers;
})();

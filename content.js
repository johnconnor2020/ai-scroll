(() => {
  if (window.__scrollNavInjected) return;
  window.__scrollNavInjected = true;

  // --- 1. PROVIDERS ---
  const PROVIDERS = {
    claude: {
      isMatch: () => window.location.hostname.includes('claude'),
      scrollContainerSelector: 'main div[class*="overflow-y-auto"]',
      // Queue feature selectors
      inputSelector: '[contenteditable="true"]',
      sendButtonSelector: 'button[aria-label="Send Message"], button[aria-label="Stop Response"]',
      isThinking: () => {
        const stopBtn = document.querySelector('button[aria-label="Stop Response"]');
        return stopBtn !== null;
      },
      getInputElement: () => document.querySelector('[contenteditable="true"]'),
      getSendButton: () => document.querySelector('button[aria-label="Send Message"]'),
      setInputValue: (el, text) => {
        el.focus();
        el.innerHTML = '';
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      getTurns: (container) => {
        const turns = [];
        const assistantSelectors = [
          '.font-claude-response',
          '[data-testid="assistant-response"]',
          '[data-testid="assistant-message"]'  
        ].join(', ');
        const selector = `[data-testid="user-message"], ${assistantSelectors}`;
        const seen = new Set();
        const allItems = Array.from(container.querySelectorAll(selector)).filter(el => {
          if (!el) return false;
          if (seen.has(el)) return false;
          const containerEl = el.closest('[data-testid="conversation-turn"]') || el.closest('.group');
          if (!containerEl) return false;
          const text = (el.innerText || '').trim();
          if (!text) return false;
          seen.add(el);
          return true;
        });
        
        allItems.forEach(el => {
           const isUser = el.getAttribute('data-testid') === 'user-message';
           const turnContainer = el.closest('[data-testid="conversation-turn"]') || el.closest('.group') || el.parentElement;
           
           let headings = [];
           if (!isUser) {
              headings = Array.from(el.querySelectorAll('h1, h2, h3, h4')).map(h => ({
                 innerText: h.innerText, element: h, tagName: h.tagName
              }));
           }
           
           turns.push({
              role: isUser ? 'user' : 'assistant',
              element: turnContainer,
              text: el.innerText || '', 
              headings: headings
           });
        });
        return turns;
      }
    },
    chatgpt: {
      isMatch: () => window.location.hostname.includes('chatgpt') || window.location.hostname.includes('openai'),
      scrollContainerSelector: 'main div[class*="overflow-y-auto"]',
      // Queue feature selectors
      inputSelector: '#prompt-textarea',
      sendButtonSelector: 'button[data-testid="send-button"], button[data-testid="stop-button"]',
      isThinking: () => {
        const stopBtn = document.querySelector('button[data-testid="stop-button"]');
        return stopBtn !== null;
      },
      getInputElement: () => document.querySelector('#prompt-textarea'),
      getSendButton: () => document.querySelector('button[data-testid="send-button"]'),
      setInputValue: (el, text) => {
        el.focus();
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      getTurns: (container) => {
        const articles = Array.from(container.querySelectorAll('article[data-turn]'));
        return articles.map(article => {
          const role = article.dataset.turn;
          let text = '';
          let headings = [];
          
          if (role === 'user') {
             const textEl = article.querySelector('[data-message-author-role="user"]');
             text = textEl ? textEl.innerText : '';
          } else {
             const contentEl = article.querySelector('[data-message-author-role="assistant"]');
             if (contentEl) {
               text = contentEl.innerText || '';
               headings = Array.from(contentEl.querySelectorAll('h1, h2, h3, h4')).map(h => ({
                 innerText: h.innerText, element: h, tagName: h.tagName
               }));
             }
          }
          return { role, element: article, text, headings };
        });
      }
    },
    gemini: {
      isMatch: () => window.location.hostname.includes('gemini') || window.location.hostname.includes('google'),
      scrollContainerSelector: '.mat-sidenav-content',
      // Queue feature selectors
      inputSelector: '.ql-editor, [contenteditable="true"]',
      sendButtonSelector: 'button[aria-label="Send message"], button[aria-label="Stop generating"]',
      isThinking: () => {
        const stopBtn = document.querySelector('button[aria-label="Stop generating"]');
        return stopBtn !== null;
      },
      getInputElement: () => document.querySelector('.ql-editor, [contenteditable="true"]'),
      getSendButton: () => document.querySelector('button[aria-label="Send message"]'),
      setInputValue: (el, text) => {
        el.focus();
        el.innerHTML = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      getTurns: (container) => {
        const turns = [];
        const items = Array.from(container.querySelectorAll('user-query, model-response'));
        items.forEach(item => {
           const isUser = item.tagName.toLowerCase() === 'user-query';
           let text = '';
           let headings = [];
           
           if (isUser) {
              const textEl = item.querySelector('.query-text');
              text = textEl ? textEl.innerText : '';
           } else {
              const markdown = item.querySelector('.markdown');
              if (markdown) {
                 text = markdown.innerText || '';
                 headings = Array.from(markdown.querySelectorAll('h1, h2, h3, h4')).map(h => ({
                   innerText: h.innerText, element: h, tagName: h.tagName
                 }));
              }
           }
           
           turns.push({ 
              role: isUser ? 'user' : 'assistant', 
              element: item, 
              text: text, 
              headings: headings 
           });
        });
        return turns;
      }
    }
  };

  // --- State Management ---
  const state = {
    isOpen: false,
    currentProvider: null,
    searchTerm: '',
    viewLevel: 2, // 1 = Prompts Only, 2 = All
    navTargets: new Map(),
    navItems: new Map(),
    focusableIds: [],
    focusedIndex: -1,
    activeNavId: null,
    scrollContainer: null,
    scrollEventTarget: null,
    scrollListenerTarget: null,
    conversationObserver: null,
    bodyObserver: null,
    suppressNavAutoScroll: false,
    navAutoScrollTimeout: null,
    // Queue feature state
    messageQueue: [],           // Array of { id, text, status: 'pending'|'sending'|'sent' }
    isAiThinking: false,        // Is AI currently generating?
    queueEnabled: true,         // Feature toggle
    thinkingObserver: null,     // MutationObserver for button state
    queueProcessing: false      // Prevent concurrent processing
  };

  // --- Initialization ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    if (!document.body) {
      requestAnimationFrame(init);
      return;
    }
    state.currentProvider = Object.values(PROVIDERS).find(p => p.isMatch());
    if (!state.currentProvider) return;

    createUI();
    applyTheme();
    observeForContainerChanges();

    const container = findConversationContainer();
    if (container) setConversationContainer(container);

    refreshNavigation();

    // Start queue feature
    startThinkingObserver();
  }

  // --- UI Creation ---
  function createUI() {
    const root = document.createElement('div');
    root.className = 'scroll-nav-root';
    root.id = 'scroll-nav-root';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'scroll-nav-toggle';
    toggleBtn.title = 'Toggle Outline (Cmd+.)';
    // Standard menu icon
    toggleBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
    `;
    
    const panel = document.createElement('div');
    panel.className = 'scroll-nav-panel';
    
    // HEADER STRUCTURE: Single Line
    panel.innerHTML = `
      <div class="scroll-nav-header">
        <span class="scroll-nav-progress" id="scroll-progress">0%</span>

        <div class="scroll-view-toggle">
             <button class="scroll-view-btn" data-level="1">Prompts</button>
             <button class="scroll-view-btn active" data-level="2">All</button>
        </div>
      </div>

      <div class="scroll-search-container">
        <div class="scroll-search-wrapper">
            <svg class="scroll-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <input type="text" class="scroll-search-input" placeholder="Filter..." id="scroll-search-input">
        </div>
      </div>

      <div class="scroll-nav-content" id="scroll-content"></div>

      <div class="scroll-queue-section" id="scroll-queue-section">
        <div class="scroll-queue-header">
          <span class="scroll-queue-title">Message Queue</span>
          <span class="scroll-queue-status" id="scroll-queue-status"></span>
        </div>
        <div class="scroll-queue-input-wrapper">
          <textarea class="scroll-queue-input" id="scroll-queue-input" placeholder="Type a follow-up message..." rows="2"></textarea>
          <button class="scroll-queue-add-btn" id="scroll-queue-add-btn" title="Add to queue (Ctrl+Shift+Enter)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
        </div>
        <ul class="scroll-queue-list" id="scroll-queue-list"></ul>
      </div>
    `;

    root.appendChild(toggleBtn);
    root.appendChild(panel);
    document.body.appendChild(root);

    toggleBtn.addEventListener('click', () => toggleNav());
    
    // Search Listeners
    const searchInput = root.querySelector('#scroll-search-input');
    searchInput.addEventListener('input', (e) => {
      state.searchTerm = e.target.value.toLowerCase();
      refreshNavigation();
    });
    searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        state.searchTerm = '';
        searchInput.value = '';
        refreshNavigation();
        searchInput.blur();
      }
    });

    // Toggle View Listeners
    const viewBtns = panel.querySelectorAll('.scroll-view-btn');
    viewBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const level = parseInt(btn.dataset.level);
            setViewLevel(level);
        });
    });

    // Queue Listeners
    const queueInput = root.querySelector('#scroll-queue-input');
    const queueAddBtn = root.querySelector('#scroll-queue-add-btn');

    queueAddBtn.addEventListener('click', () => {
      const text = queueInput.value.trim();
      if (text) {
        addToQueue(text);
        queueInput.value = '';
      }
    });

    queueInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // Ctrl+Shift+Enter or Cmd+Shift+Enter to queue
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        const text = queueInput.value.trim();
        if (text) {
          addToQueue(text);
          queueInput.value = '';
        }
      }
      // Regular Enter just adds newline (default behavior)
    });

    // Keyboard Shortcuts (Cmd + . or Cmd + ;)
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === '.' || e.key === ';')) {
            e.preventDefault();
            toggleNav();
            return;
        }
        if (!state.isOpen) return;

        if (e.key === 'Escape') {
            toggleNav(false);
            return;
        }

        const activeEl = document.activeElement;
        const typingContext = activeEl && (
          activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.isContentEditable
        );
        if (typingContext) return;

        if (e.key === 'ArrowDown' || e.key === 'j') {
            e.preventDefault();
            moveFocus(1);
        } else if (e.key === 'ArrowUp' || e.key === 'k') {
            e.preventDefault();
            moveFocus(-1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            activateFocusedItem();
        } else if (e.key === 'ArrowLeft') { 
            e.preventDefault();
            setViewLevel(1); // Set to "Prompts"
        } else if (e.key === 'ArrowRight') { 
            e.preventDefault();
            setViewLevel(2); // Set to "All"
        }
    });
  }

  function toggleNav(forceState) {
    const root = document.getElementById('scroll-nav-root');
    const newState = forceState !== undefined ? forceState : !state.isOpen;
    state.isOpen = newState;
    root.classList.toggle('scroll-nav-open', newState);
    
    if (newState) {
        const activeIndex = state.focusableIds.indexOf(state.activeNavId);
        if (activeIndex >= 0) {
          state.focusedIndex = activeIndex;
        } else if (state.focusableIds.length > 0) {
          state.focusedIndex = 0;
        } else {
          state.focusedIndex = -1;
        }
    } else {
        state.focusedIndex = -1;
    }
    updateFocusVisuals();
  }

  function applyTheme() {
    const root = document.getElementById('scroll-nav-root');
    const host = window.location.hostname;
    if (host.includes('chatgpt')) root.classList.add('theme-chatgpt');
    else if (host.includes('gemini') || host.includes('google')) root.classList.add('theme-gemini');
    else root.classList.add('theme-claude');
  }

  // --- NEW FUNCTION ---
  function setViewLevel(level) {
    if (state.viewLevel === level) return; // Don't re-render if no change
    const root = document.getElementById('scroll-nav-root');
    if (!root) return;
    
    const viewBtns = root.querySelectorAll('.scroll-view-btn');
    viewBtns.forEach(b => {
        const btnLevel = parseInt(b.dataset.level);
        b.classList.toggle('active', btnLevel === level);
    });
    
    state.viewLevel = level;
    refreshNavigation();
  }

  // --- Core Navigation Logic ---
  function refreshNavigation() {
    const contentEl = document.getElementById('scroll-content');
    if (!contentEl || !state.currentProvider || !state.scrollContainer) return;

    let turns = state.currentProvider.getTurns(state.scrollContainer);
    updateScrollTargetFromTurns(turns);
    
    turns.sort((a, b) => (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);

    state.navTargets.clear();
    state.navItems.clear();
    const focusOrder = [];

    const list = document.createElement('ul');
    list.className = 'scroll-nav-list';
    let hasVisibleItems = false;

    turns.forEach((turn, index) => {
      const isUser = turn.role === 'user';
      
      // --- VIEW LEVEL LOGIC ---
      if (state.viewLevel === 1 && !isUser) return;

      // --- SEARCH FILTERING ---
      const rawText = (turn.text || '').toLowerCase();
      const term = state.searchTerm.trim();
      const promptMatch = term === '' || rawText.includes(term);
      const matchingHeadings = turn.headings.filter(h => term === '' || h.innerText.toLowerCase().includes(term));
      
      if (!promptMatch && matchingHeadings.length === 0) return;
      hasVisibleItems = true;

      // CREATE ITEM
      const li = document.createElement('li');
      li.className = 'scroll-nav-item';
      if (!isUser) li.classList.add('is-assistant');

      // 1. Icon Logic
      const userIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
      const aiIcon   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>`;
      
      const iconSpan = document.createElement('span');
      iconSpan.className = 'scroll-nav-icon';
      iconSpan.innerHTML = isUser ? userIcon : aiIcon;
      li.appendChild(iconSpan); 

      // 2. Text Logic
      const textSpan = document.createElement('span');
      textSpan.className = 'scroll-nav-text';
      
      let displayText = cleanText(turn.text);
      if (state.searchTerm && rawText.includes(term)) {
          const idx = rawText.indexOf(term);
          const start = Math.max(0, idx - 10);
          const end = Math.min(rawText.length, idx + 30);
          displayText = "..." + rawText.substring(start, end) + "...";
      }
      textSpan.textContent = displayText;
      li.appendChild(textSpan);   

      // 3. Wiring
      const targetId = `nav-target-${index}`;
      state.navTargets.set(targetId, turn.element);
      state.navItems.set(targetId, li);
      focusOrder.push(targetId);
      
      li.addEventListener('click', (e) => {
        e.stopPropagation();
        scrollToElement(turn.element, targetId);
      });

      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(turn.text).then(() => {
            const originalText = textSpan.textContent;
            textSpan.textContent = "Copied to clipboard!";
            textSpan.style.color = "var(--theme-accent)";
            setTimeout(() => {
                textSpan.textContent = originalText;
                textSpan.style.color = "";
            }, 1200);
        });
      });

      // 4. Headings (Sub-list)
      const showSubHeadings = (state.viewLevel === 2 || state.searchTerm.length > 0);
      const headingsToShow = state.searchTerm ? matchingHeadings : turn.headings;
      
      if (showSubHeadings && headingsToShow.length > 0) {
        const subList = document.createElement('ul');
        subList.className = 'scroll-nav-sublist';
        
        headingsToShow.forEach((h, hIndex) => {
          const subLi = document.createElement('li');
          subLi.className = 'scroll-nav-subitem';
          subLi.textContent = h.innerText;
          
          const hId = `${targetId}-h-${hIndex}`;
          state.navTargets.set(hId, h.element);
          state.navItems.set(hId, subLi);
          focusOrder.push(hId);
          
          subLi.addEventListener('click', (e) => {
            e.stopPropagation();
            scrollToElement(h.element, hId);
          });
          subList.appendChild(subLi);
        });
        li.appendChild(subList);
      }

      list.appendChild(li);
    });

    contentEl.innerHTML = '';
    if (hasVisibleItems) contentEl.appendChild(list);
    else contentEl.innerHTML = `<div class="scroll-nav-empty-state">No matches found</div>`;

    state.focusableIds = focusOrder;
    if (!focusOrder.length) {
      state.focusedIndex = -1;
    } else if (state.focusedIndex >= focusOrder.length) {
      state.focusedIndex = focusOrder.length - 1;
    }
    updateFocusVisuals();
    
    // Trigger update to show current position immediately
    if (!state.searchTerm) setTimeout(updateScrollProgress, 100);
  }

  function cleanText(text) {
    if (!text) return '...';
    let clean = text.trim().replace(/[#*`]/g, '').replace(/\s+/g, ' ');
    return clean.length > 50 ? clean.substring(0, 48) + '...' : clean;
  }

  function scrollToElement(element, targetId) {
    if (!element) return;
    state.suppressNavAutoScroll = true;
    if (state.navAutoScrollTimeout) clearTimeout(state.navAutoScrollTimeout);
    state.navAutoScrollTimeout = setTimeout(() => { state.suppressNavAutoScroll = false; }, 800);
    setActiveItem(targetId);

    const scrollSource = getScrollSourceNode();
    const offset = getScrollOffset();

    if (!scrollSource) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (isDocumentScroller(scrollSource)) {
      const globalTop = window.scrollY || window.pageYOffset || 0;
      const targetTop = element.getBoundingClientRect().top + globalTop - offset;
      window.scrollTo({ top: targetTop, behavior: 'smooth' });
    } else {
      const containerRect = scrollSource.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const targetTop = scrollSource.scrollTop + (elementRect.top - containerRect.top) - offset;
      if (typeof scrollSource.scrollTo === 'function') {
        scrollSource.scrollTo({ top: targetTop, behavior: 'smooth' });
      } else {
        scrollSource.scrollTop = targetTop;
      }
    }

    const idx = state.focusableIds.indexOf(targetId);
    if (idx !== -1) {
      state.focusedIndex = idx;
      updateFocusVisuals();
    }
  }

  function setActiveItem(id) {
    if (state.activeNavId === id) return;
    if (state.activeNavId) {
      const oldItem = state.navItems.get(state.activeNavId);
      if (oldItem) oldItem.classList.remove('scroll-nav-active');
    }
    const newItem = state.navItems.get(id);
    if (newItem) {
      newItem.classList.add('scroll-nav-active');
      newItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    state.activeNavId = id;
  }

  function moveFocus(direction) {
    const ids = state.focusableIds;
    if (!ids.length) return;
    if (state.focusedIndex === -1) {
      const activeIndex = state.focusableIds.indexOf(state.activeNavId);
      if (activeIndex >= 0) {
        state.focusedIndex = activeIndex;
      } else {
        state.focusedIndex = direction > 0 ? 0 : ids.length - 1;
      }
    } else {
      state.focusedIndex = (state.focusedIndex + direction + ids.length) % ids.length;
    }
    updateFocusVisuals();
  }

  function activateFocusedItem() {
    if (state.focusedIndex === -1) return;
    const id = state.focusableIds[state.focusedIndex];
    if (!id) return;
    const target = state.navTargets.get(id);
    if (target) scrollToElement(target, id);
  }

  function updateFocusVisuals() {
    const root = document.getElementById('scroll-nav-root');
    if (!root) return;
    root.querySelectorAll('.scroll-nav-focused').forEach(el => el.classList.remove('scroll-nav-focused'));
    if (state.focusedIndex === -1) return;
    const id = state.focusableIds[state.focusedIndex];
    const el = id ? state.navItems.get(id) : null;
    if (!el) return;
    el.classList.add('scroll-nav-focused');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function updateScrollProgress() {
    if (!state.scrollContainer) return; 
    
    const scrollSource = getScrollSourceNode();
    if (!scrollSource) return;

    let scrolled = 0;
    let max = 0;

    if (scrollSource === document || scrollSource === document.body || scrollSource === document.documentElement) {
      const docEl = document.scrollingElement || document.documentElement || document.body;
      scrolled = docEl.scrollTop || 0;
      max = docEl.scrollHeight - docEl.clientHeight;
    } else {
      scrolled = scrollSource.scrollTop;
      max = scrollSource.scrollHeight - scrollSource.clientHeight;
    }

    if (max < 0) max = 0;
    let pct = max > 0 ? Math.round((scrolled / max) * 100) : 0;
    const label = document.getElementById('scroll-progress');
    if (label) label.textContent = `${pct}%`;

    if (state.suppressNavAutoScroll) return;
    
    const headerOffset = getScrollOffset(); 
    const viewLine = state.scrollContainer.getBoundingClientRect().top + headerOffset;
    let closestId = null;
    let minDist = Infinity;

    for (const [id, el] of state.navTargets) {
       if (!el.isConnected) continue;
       const rect = el.getBoundingClientRect();
       const dist = Math.abs(rect.top - viewLine);
       if (dist < minDist) {
         minDist = dist;
         closestId = id;
       }
    }
    if (closestId) setActiveItem(closestId);
  }

  function findConversationContainer() {
    if (!state.currentProvider) return null;
    return document.querySelector(state.currentProvider.scrollContainerSelector) || 
           document.querySelector('main') || 
           document.body;
  }

  function setConversationContainer(node) {
    if (state.conversationObserver) state.conversationObserver.disconnect();
    state.scrollContainer = node;
    state.conversationObserver = new MutationObserver(debounce(() => { refreshNavigation(); }, 500));
    state.conversationObserver.observe(node, { childList: true, subtree: true });

    setScrollEventTarget(node);

    updateScrollProgress();
  }

  function setScrollEventTarget(target) {
    const metricsTarget = target || null;
    const listenerTarget = (metricsTarget === document.body || metricsTarget === document.documentElement) ? window : metricsTarget;
    
    if (state.scrollEventTarget === metricsTarget && state.scrollListenerTarget === listenerTarget) return;

    if (state.scrollListenerTarget) {
      state.scrollListenerTarget.removeEventListener('scroll', onScroll);
    }

    state.scrollEventTarget = metricsTarget;
    state.scrollListenerTarget = listenerTarget || null;

    if (state.scrollListenerTarget && state.scrollListenerTarget.addEventListener) {
      state.scrollListenerTarget.addEventListener('scroll', onScroll, { passive: true });
    }

    updateScrollProgress();
  }

  function observeForContainerChanges() {
    state.bodyObserver = new MutationObserver(() => {
      const candidate = findConversationContainer();
      if (candidate && candidate !== state.scrollContainer) {
        setConversationContainer(candidate);
        refreshNavigation();
      }
    });
    state.bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  function updateScrollTargetFromTurns(turns) {
    if (!turns || !turns.length) return;
    const firstWithElement = turns.find(t => t.element && t.element.isConnected);
    if (!firstWithElement) return;
    const scrollable = findScrollableAncestor(firstWithElement.element);
    if (scrollable) setScrollEventTarget(scrollable);
  }

  function findScrollableAncestor(node) {
    let current = node;
    while (current) {
      if (elementCanScroll(current)) return current;
      if (current === document.body || current === document.documentElement) break;
      current = getParentNode(current);
    }
    return document.scrollingElement || document.documentElement || document.body;
  }

  function getParentNode(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    if (root && root.host) return root.host;
    return null;
  }

  function elementCanScroll(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    const overflowY = style.overflowY || style.overflow;
    if (!overflowY || overflowY === 'visible') return false;
    const contentLarger = el.scrollHeight - el.clientHeight > 4;
    return contentLarger && /(auto|scroll|overlay)/.test(overflowY);
  }

  function getScrollSourceNode() {
    return state.scrollEventTarget || state.scrollContainer || document.scrollingElement || document.documentElement || document.body;
  }

  function isDocumentScroller(node) {
    if (!node) return false;
    const docEl = document.documentElement;
    const body = document.body;
    const scrollingEl = document.scrollingElement;
    return node === body || node === docEl || node === scrollingEl;
  }

  function getScrollOffset() {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const dynamicOffset = viewportHeight ? viewportHeight * 0.15 : 0;
    const baseOffset = dynamicOffset || 110;
    const clamped = Math.min(Math.max(baseOffset, 80), 170);
    return clamped;
  }

  function onScroll() {
     if (state.scrollAnimationFrame) return;
     state.scrollAnimationFrame = requestAnimationFrame(() => {
       updateScrollProgress();
       state.scrollAnimationFrame = null;
     });
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    }
  }

  // --- Queue Feature Functions ---

  function addToQueue(text) {
    const id = `queue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    state.messageQueue.push({ id, text, status: 'pending' });
    renderQueue();
    updateQueueStatus();
    // If AI is not thinking, process immediately
    if (!state.isAiThinking && !state.queueProcessing) {
      processQueue();
    }
  }

  function removeFromQueue(id) {
    state.messageQueue = state.messageQueue.filter(m => m.id !== id);
    renderQueue();
    updateQueueStatus();
  }

  function renderQueue() {
    const list = document.getElementById('scroll-queue-list');
    if (!list) return;

    list.innerHTML = '';

    state.messageQueue.forEach((msg, index) => {
      const li = document.createElement('li');
      li.className = `scroll-queue-item scroll-queue-${msg.status}`;
      li.dataset.id = msg.id;

      // Status icon
      const statusIcon = document.createElement('span');
      statusIcon.className = 'scroll-queue-item-status';
      if (msg.status === 'pending') {
        statusIcon.innerHTML = `<span class="scroll-queue-number">${index + 1}</span>`;
      } else if (msg.status === 'sending') {
        statusIcon.innerHTML = `<svg class="scroll-queue-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
      } else {
        statusIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      }
      li.appendChild(statusIcon);

      // Text
      const textSpan = document.createElement('span');
      textSpan.className = 'scroll-queue-item-text';
      textSpan.textContent = msg.text.length > 60 ? msg.text.substring(0, 58) + '...' : msg.text;
      textSpan.title = msg.text;
      li.appendChild(textSpan);

      // Delete button (only for pending)
      if (msg.status === 'pending') {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'scroll-queue-item-delete';
        deleteBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeFromQueue(msg.id);
        });
        li.appendChild(deleteBtn);
      }

      list.appendChild(li);
    });

    // Show/hide queue section based on content
    const section = document.getElementById('scroll-queue-section');
    if (section) {
      section.classList.toggle('has-items', state.messageQueue.length > 0);
    }
  }

  function updateQueueStatus() {
    const statusEl = document.getElementById('scroll-queue-status');
    if (!statusEl) return;

    const pending = state.messageQueue.filter(m => m.status === 'pending').length;

    if (state.isAiThinking) {
      statusEl.innerHTML = `<span class="scroll-thinking-dot"></span> AI thinking...`;
      statusEl.className = 'scroll-queue-status thinking';
    } else if (pending > 0) {
      statusEl.textContent = `${pending} queued`;
      statusEl.className = 'scroll-queue-status';
    } else {
      statusEl.textContent = '';
      statusEl.className = 'scroll-queue-status';
    }
  }

  function processQueue() {
    if (state.queueProcessing) return;
    if (state.isAiThinking) return;
    if (!state.currentProvider) return;

    const nextMsg = state.messageQueue.find(m => m.status === 'pending');
    if (!nextMsg) return;

    state.queueProcessing = true;
    nextMsg.status = 'sending';
    renderQueue();

    // Small delay to ensure UI is ready
    setTimeout(() => {
      sendQueuedMessage(nextMsg);
    }, 500);
  }

  function sendQueuedMessage(msg) {
    const provider = state.currentProvider;
    if (!provider) {
      state.queueProcessing = false;
      return;
    }

    const inputEl = provider.getInputElement();
    const sendBtn = provider.getSendButton();

    if (!inputEl || !sendBtn) {
      // Can't find elements, retry later
      setTimeout(() => {
        state.queueProcessing = false;
        processQueue();
      }, 1000);
      return;
    }

    // Set the input value
    provider.setInputValue(inputEl, msg.text);

    // Wait for input to register, then click send
    setTimeout(() => {
      const sendBtnNow = provider.getSendButton();
      if (sendBtnNow) {
        sendBtnNow.click();
        msg.status = 'sent';
        renderQueue();

        // Remove sent message after a short delay
        setTimeout(() => {
          state.messageQueue = state.messageQueue.filter(m => m.id !== msg.id);
          renderQueue();
          updateQueueStatus();
        }, 2000);
      }
      state.queueProcessing = false;
    }, 200);
  }

  function startThinkingObserver() {
    if (state.thinkingObserver) return;
    if (!state.currentProvider) return;

    // Check initial state
    state.isAiThinking = state.currentProvider.isThinking();
    updateQueueStatus();

    // Create observer to watch for button changes
    state.thinkingObserver = new MutationObserver(() => {
      const wasThinking = state.isAiThinking;
      state.isAiThinking = state.currentProvider.isThinking();

      if (wasThinking !== state.isAiThinking) {
        updateQueueStatus();

        // AI just finished thinking - process queue
        if (wasThinking && !state.isAiThinking) {
          // Wait a moment for the UI to settle
          setTimeout(() => {
            if (!state.isAiThinking) {
              processQueue();
            }
          }, 1000);
        }
      }
    });

    // Observe the whole body for button changes
    state.thinkingObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'data-testid']
    });
  }
})();
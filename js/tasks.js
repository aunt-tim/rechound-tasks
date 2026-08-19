// ─── TASKS MODULE ──────────────────────────────────────────────────────────
// Hierarchical business-unit task tracker. Ported to match the RecHound
// manga theme and wired into the app's existing store/sync (see store.js,
// sync.js) instead of manual JSON export/import.

(function () {

  // ── Storage ────────────────────────────────────────────────────────────
  // nodes + priorityOrder → _store (Drive sync) AND localStorage (survives
  // refresh even when Drive isn't connected). Open/collapsed UI state is
  // session-only and never persisted.
  function tkGet(k, def) {
    const sv = _store['tasks-' + k];
    if (sv !== undefined) { try { return JSON.parse(sv) ?? def; } catch { return def; } }
    const lv = localStorage.getItem('tasks-' + k);
    if (lv !== null) { try { return JSON.parse(lv) ?? def; } catch { return def; } }
    return def;
  }
  function tkSet(k, v) {
    const s = JSON.stringify(v);
    _store['tasks-' + k] = s;
    localStorage.setItem('tasks-' + k, s);
  }
  function saveNodes()         { tkSet('nodes', state.nodes); window.gdSchedulePush?.(); }
  function savePriorityOrder() { tkSet('priorityOrder', state.priorityOrder); window.gdSchedulePush?.(); }

  /* ---------------- Data model ---------------- */

  function uid(prefix) {
    if (window.crypto && crypto.randomUUID) return prefix + '-' + crypto.randomUUID();
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  }

  function leaf(id, name) { return { id: id, name: name, tasks: [] }; }
  function branch(id, name, childIds, color, leafParent) { return { id: id, name: name, childIds: childIds, color: color || null, leafParent: !!leafParent }; }

  function buildInitialNodes() {
    var nodes = {};

    nodes['cashflow'] = leaf('cashflow', 'Cash Flow');
    nodes['sales-fin'] = leaf('sales-fin', 'Sales');
    nodes['wages'] = leaf('wages', 'Wages');
    nodes['finance'] = branch('finance', 'Finance', ['cashflow', 'sales-fin', 'wages'], '#1565C0', true);

    nodes['content'] = leaf('content', 'Content');
    nodes['websiteseo'] = leaf('websiteseo', 'Website / SEO');
    nodes['community'] = leaf('community', 'Community');
    nodes['xeropartners'] = leaf('xeropartners', 'Xero App Store / Partners');
    nodes['webinars'] = leaf('webinars', 'Webinars / Events');
    nodes['marketing'] = branch('marketing', 'Marketing (Top of funnel)', ['content', 'websiteseo', 'community', 'xeropartners', 'webinars'], null, true);

    nodes['emails-leads'] = leaf('emails-leads', 'Emails');
    nodes['newsletter'] = leaf('newsletter', 'Newsletter');
    nodes['onboarding'] = leaf('onboarding', 'Onboarding');
    nodes['leads'] = branch('leads', 'Leads (middle funnel)', ['emails-leads', 'newsletter', 'onboarding'], null, true);

    nodes['emails-chasing'] = leaf('emails-chasing', 'Emails');
    nodes['chasing'] = branch('chasing', 'Chasing (bottom funnel)', ['emails-chasing'], null, true);

    nodes['salesmarketing'] = branch('salesmarketing', 'Sales & Marketing', ['marketing', 'leads', 'chasing'], '#FF6B00');

    nodes['usersupport'] = leaf('usersupport', 'User Support');
    nodes['userengagement'] = leaf('userengagement', 'User Engagement');
    nodes['customersuccess'] = branch('customersuccess', 'Customer Success', ['usersupport', 'userengagement'], '#2E7D32', true);

    nodes['supportqueries'] = leaf('supportqueries', 'Support Queries');
    nodes['newfeatures'] = leaf('newfeatures', 'New Features');
    nodes['bugs'] = leaf('bugs', 'Bugs');
    nodes['product'] = branch('product', 'Product', ['supportqueries', 'newfeatures', 'bugs'], '#6A1B9A', true);

    nodes['root'] = branch('root', 'Home', ['finance', 'salesmarketing', 'customersuccess', 'product']);

    return nodes;
  }

  var state = {
    nodes: tkGet('nodes', null) || buildInitialNodes(),
    openIds: new Set(),
    openTaskIds: new Set(),
    priorityOrder: tkGet('priorityOrder', [])
  };

  /* ---------------- Helpers ---------------- */

  function isLeaf(node) { return !!node.tasks; }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureTaskShape(task) {
    if (!task.notes) task.notes = [];
    if (!task.subtasks) task.subtasks = [];
    return task;
  }

  // Stamp completedAt whenever a task/subtask is marked done, so the
  // "Completed" side-panel tab can sort most-recently-finished first.
  // updatedAt is bumped on every meaningful edit so cross-device sync can
  // merge concurrent changes by picking whichever copy of a task is newer
  // instead of one device's whole snapshot blindly overwriting the other's.
  function toggleDone(item) {
    item.done = !item.done;
    if (item.done) item.completedAt = Date.now();
    else delete item.completedAt;
    item.updatedAt = Date.now();
  }

  // Double-click a task/subtask's text to rename it in place.
  function makeTextEditable(textEl, item) {
    textEl.title = 'Double-click to rename';
    textEl.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      startEdit();
    });

    function startEdit() {
      var current = item.text;
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'tk-text-edit';
      input.maxLength = 140;
      input.value = current;
      textEl.replaceWith(input);
      input.focus();
      input.select();

      var done = false;
      function finish(save) {
        if (done) return;
        done = true;
        if (save) {
          var val = input.value.trim();
          if (val && val !== current) {
            item.text = val;
            item.updatedAt = Date.now();
            saveNodes();
            renderTree();
            return;
          }
        }
        input.replaceWith(textEl);
      }

      input.addEventListener('click', function (e) { e.stopPropagation(); });
      input.addEventListener('blur', function () { finish(true); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
    }
  }

  // Deletes are soft (deleted: true) rather than splicing the array, so a
  // delete has an updatedAt the cross-device merge can compare against a
  // concurrent edit — otherwise a plain removal is invisible to the merge
  // and the task gets unioned back in from whichever device hasn't synced
  // the deletion yet. These helpers keep every other function working with
  // "what's actually still there" without needing to know that.
  function liveTasks(node)    { return (node.tasks || []).filter(function (t) { return !t.deleted; }); }
  function liveSubtasks(task) { return (task.subtasks || []).filter(function (s) { return !s.deleted; }); }

  function taskContribution(task) {
    ensureTaskShape(task);
    var subtasks = liveSubtasks(task);
    if (subtasks.length > 0) {
      var done = subtasks.filter(function (s) { return s.done; }).length;
      return { total: subtasks.length, done: done };
    }
    return { total: 1, done: task.done ? 1 : 0 };
  }

  function computeProgress(id) {
    var node = state.nodes[id];
    if (!node) return { total: 0, done: 0 };
    if (isLeaf(node)) {
      var total = 0, done = 0;
      liveTasks(node).forEach(function (t) {
        var c = taskContribution(t);
        total += c.total; done += c.done;
      });
      return { total: total, done: done };
    }
    var total2 = 0, done2 = 0;
    node.childIds.forEach(function (cid) {
      var p = computeProgress(cid);
      total2 += p.total; done2 += p.done;
    });
    return { total: total2, done: done2 };
  }

  function pct(p) { return p.total === 0 ? 0 : Math.round((p.done / p.total) * 100); }

  function collectAllIds() {
    var ids = [];
    Object.keys(state.nodes).forEach(function (id) { if (id !== 'root') ids.push(id); });
    return ids;
  }

  function findParentOf(id) {
    var parent = null;
    Object.keys(state.nodes).forEach(function (key) {
      var n = state.nodes[key];
      if (!isLeaf(n) && n.childIds.indexOf(id) !== -1) parent = key;
    });
    return parent === 'root' ? null : parent;
  }

  function ancestorChain(id) {
    var chain = [];
    var cursor = id;
    var guard = 0;
    while (cursor && guard < 20) {
      chain.unshift(cursor);
      cursor = findParentOf(cursor);
      guard++;
    }
    return chain;
  }

  function collectAllTasks() {
    var result = [];
    function walk(id, unitId, unitName, unitColor) {
      var node = state.nodes[id];
      if (isLeaf(node)) {
        liveTasks(node).forEach(function (t) {
          ensureTaskShape(t);
          var subtasks = liveSubtasks(t);
          if (subtasks.length > 0) {
            subtasks.forEach(function (st) {
              ensureTaskShape(st);
              result.push({
                task: st, leafId: id, leafName: node.name,
                unitId: unitId, unitName: unitName, unitColor: unitColor,
                parentTaskId: t.id, parentTaskText: t.text
              });
            });
          } else {
            result.push({
              task: t, leafId: id, leafName: node.name,
              unitId: unitId, unitName: unitName, unitColor: unitColor,
              parentTaskId: null, parentTaskText: null
            });
          }
        });
      } else {
        node.childIds.forEach(function (cid) { walk(cid, unitId, unitName, unitColor); });
      }
    }
    state.nodes['root'].childIds.forEach(function (id) {
      var u = state.nodes[id];
      walk(id, id, u.name, u.color);
    });
    return result;
  }

  /* ---------------- Ring / progress bar rendering ---------------- */

  var RING_R = 20;
  var RING_CIRC = 2 * Math.PI * RING_R;

  function setRing(circleEl, pctVal) {
    circleEl.setAttribute('stroke-dasharray', RING_CIRC.toFixed(2));
    var offset = RING_CIRC * (1 - pctVal / 100);
    circleEl.style.strokeDashoffset = offset.toFixed(2);
    circleEl.classList.toggle('complete', pctVal === 100 && RING_CIRC > 0);
  }

  function progressBarHtml(p) {
    var v = pct(p);
    var cls = p.total === 0 ? 'empty' : (v === 100 ? 'complete' : '');
    return '<div class="tk-bar-track"><div class="tk-bar-fill ' + cls + '" style="width:' + v + '%"></div></div>';
  }

  function metaText(p) {
    if (p.total === 0) return 'no tasks';
    return p.done + '/' + p.total + ' &middot; ' + pct(p) + '%';
  }

  /* ---------------- Header stat ---------------- */

  function updateHeaderStats() {
    var p = computeProgress('root');
    var v = pct(p);
    setRing(document.getElementById('tkHeaderRingFill'), v);
    document.getElementById('tkHeaderRingPct').textContent = v + '%';
    document.getElementById('tkHeaderStatValue').textContent = p.done + ' / ' + p.total + ' tasks';
  }

  /* ---------------- Tree rendering ---------------- */

  function renderTree() {
    var root = document.getElementById('tkTreeRoot');
    if (!root) return;
    root.innerHTML = '';
    var rootNode = state.nodes['root'];
    rootNode.childIds.forEach(function (cid) {
      root.appendChild(buildNodeLi(cid, 0));
    });
    updateHeaderStats();
    renderSidePanel();
  }

  function buildNodeLi(id, depth) {
    var node = state.nodes[id];
    var open = state.openIds.has(id);
    var li = document.createElement('li');
    li.className = 'tk-node' + (open ? ' open' : '');
    li.dataset.id = id;
    li.dataset.depth = depth;

    var row = document.createElement('div');
    row.className = 'tk-row';
    row.setAttribute('tabindex', '0');
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', open ? 'true' : 'false');

    var chevron = document.createElement('span');
    chevron.className = 'tk-toggle';
    chevron.innerHTML = '&#9656;';
    row.appendChild(chevron);

    if (node.color) {
      var dot = document.createElement('span');
      dot.className = 'tk-dot';
      dot.style.background = node.color;
      row.appendChild(dot);
    }

    var nameSpan = document.createElement('span');
    nameSpan.className = 'tk-name';
    nameSpan.textContent = node.name;
    row.appendChild(nameSpan);

    var p = computeProgress(id);
    var progWrap = document.createElement('div');
    progWrap.className = 'tk-progress';
    progWrap.innerHTML = progressBarHtml(p) + '<span class="tk-meta">' + metaText(p) + '</span>';
    row.appendChild(progWrap);

    function toggle() {
      if (state.openIds.has(id)) {
        state.openIds.delete(id);
        li.classList.remove('open');
        row.setAttribute('aria-expanded', 'false');
      } else {
        state.openIds.add(id);
        li.classList.add('open');
        row.setAttribute('aria-expanded', 'true');
      }
    }
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    li.appendChild(row);

    var wrap = document.createElement('div');
    wrap.className = 'tk-children-wrap';
    var inner = document.createElement('div');
    inner.className = 'tk-children-inner';

    if (isLeaf(node)) {
      inner.appendChild(buildLeafDetail(node));
    } else {
      var ul = document.createElement('ul');
      ul.className = 'tk-children';
      ul.dataset.depth = depth + 1;
      node.childIds.forEach(function (cid) {
        ul.appendChild(buildNodeLi(cid, depth + 1));
      });
      inner.appendChild(ul);
    }
    wrap.appendChild(inner);
    li.appendChild(wrap);

    return li;
  }

  function buildLeafDetail(node) {
    var container = document.createElement('div');
    container.className = 'tk-leaf-detail';
    container.addEventListener('click', function (e) { e.stopPropagation(); });

    var visibleTasks = liveTasks(node);
    if (visibleTasks.length > 0) {
      var list = document.createElement('ul');
      list.className = 'tk-task-list';
      visibleTasks.forEach(function (task) {
        list.appendChild(buildTaskRow(node, task));
      });
      wireTaskDragging(list, node);
      container.appendChild(list);
    }

    var addForm = document.createElement('form');
    addForm.className = 'tk-add-row tk-add-task-row';
    addForm.innerHTML =
      '<input type="text" class="tool-input" placeholder="Add a task and press Enter" maxlength="140" required>' +
      '<button type="submit" class="tool-btn">+ Add task</button>';
    var addInput = addForm.querySelector('input');
    addForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = addInput.value.trim();
      if (!text) return;
      node.tasks.push({ id: uid('task'), text: text, done: false, createdAt: Date.now(), updatedAt: Date.now(), notes: [], subtasks: [] });
      state.openIds.add(node.id);
      saveNodes();
      renderTree();
    });
    container.appendChild(addForm);

    return container;
  }

  /* rAF-throttled drag reorderer shared by task lists and the priority panel. */
  function createDragReorderer(list, rowSelector) {
    var pending = false;
    var lastY = 0;

    function getDragAfterElement(y) {
      var rows = Array.prototype.slice.call(list.querySelectorAll(rowSelector + ':not(.dragging)'));
      var result = { offset: -Infinity, element: null };
      rows.forEach(function (row) {
        var box = row.getBoundingClientRect();
        var offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > result.offset) { result = { offset: offset, element: row }; }
      });
      return result.element;
    }

    return function schedule(y) {
      lastY = y;
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        var dragging = list.querySelector(rowSelector + '.dragging');
        if (!dragging) return;
        var afterEl = getDragAfterElement(lastY);
        if (afterEl == null) {
          if (list.lastElementChild !== dragging) list.appendChild(dragging);
        } else if (afterEl !== dragging.nextSibling && afterEl !== dragging) {
          list.insertBefore(dragging, afterEl);
        }
      });
    };
  }

  function wireTaskDragging(list, node) {
    var schedule = createDragReorderer(list, '.tk-task-row');

    list.addEventListener('dragover', function (e) {
      e.preventDefault();
      schedule(e.clientY);
    });

    list.addEventListener('drop', function (e) {
      e.preventDefault();
      var orderedIds = Array.prototype.map.call(list.querySelectorAll('.tk-task-row'), function (row) {
        return row.dataset.taskId;
      });
      node.tasks.sort(function (a, b) { return orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id); });
      saveNodes();
      renderTree();
    });
  }

  function buildTaskRow(node, task) {
    ensureTaskShape(task);
    var visibleSubtasks = liveSubtasks(task);
    var hasSubtasks = visibleSubtasks.length > 0;
    var contribution = taskContribution(task);
    var open = state.openTaskIds.has(task.id);

    var li = document.createElement('li');
    li.className = 'tk-task-row' + (!hasSubtasks && task.done ? ' done' : '') + (open ? ' open' : '');
    li.draggable = true;
    li.dataset.taskId = task.id;

    li.addEventListener('dragstart', function (e) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', task.id);
      requestAnimationFrame(function () { li.classList.add('dragging'); });
    });
    li.addEventListener('dragend', function () {
      li.classList.remove('dragging');
    });

    var head = document.createElement('div');
    head.className = 'tk-task-head';

    function toggleOpen() {
      if (state.openTaskIds.has(task.id)) { state.openTaskIds.delete(task.id); li.classList.remove('open'); }
      else { state.openTaskIds.add(task.id); li.classList.add('open'); }
    }
    head.addEventListener('click', toggleOpen);

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tk-task-toggle';
    toggle.setAttribute('aria-label', 'Show subtasks');
    toggle.innerHTML = '&#9656;';
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleOpen();
    });

    var handle = document.createElement('span');
    handle.className = 'tk-drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.innerHTML = '&#8942;&#8942;';

    var mainControl;
    if (hasSubtasks) {
      mainControl = document.createElement('div');
      mainControl.className = 'tk-progress-mini';
      mainControl.innerHTML = progressBarHtml(contribution);
    } else {
      mainControl = document.createElement('button');
      mainControl.type = 'button';
      mainControl.className = 'tk-check' + (task.done ? ' checked' : '');
      mainControl.setAttribute('aria-label', task.done ? 'Mark incomplete' : 'Mark complete');
      mainControl.innerHTML = task.done ? '&#10003;' : '';
      mainControl.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleDone(task);
        saveNodes();
        renderTree();
      });
    }

    var text = document.createElement('span');
    text.className = 'tk-text';
    text.textContent = task.text;
    makeTextEditable(text, task);

    var noteBtn = buildNoteButton(task);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'tk-del';
    del.setAttribute('aria-label', 'Delete task');
    del.innerHTML = '&times;';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      task.deleted = true;
      task.updatedAt = Date.now();
      state.openTaskIds.delete(task.id);
      saveNodes();
      renderTree();
    });

    head.appendChild(toggle);
    head.appendChild(handle);
    head.appendChild(mainControl);
    head.appendChild(text);
    if (hasSubtasks) {
      var metaEl = document.createElement('span');
      metaEl.className = 'tk-progress-meta';
      metaEl.textContent = contribution.done + '/' + contribution.total;
      head.appendChild(metaEl);
    }
    head.appendChild(noteBtn);
    head.appendChild(del);
    li.appendChild(head);

    var wrap = document.createElement('div');
    wrap.className = 'tk-subtask-wrap';
    var inner = document.createElement('div');
    inner.className = 'tk-subtask-inner';
    inner.addEventListener('click', function (e) { e.stopPropagation(); });

    if (hasSubtasks) {
      var subList = document.createElement('ul');
      subList.className = 'tk-subtask-list';
      visibleSubtasks.forEach(function (st) {
        subList.appendChild(buildSubtaskRow(task, st));
      });
      wireSubtaskDragging(subList, task);
      inner.appendChild(subList);
    }

    var addSubForm = document.createElement('form');
    addSubForm.className = 'tk-add-row';
    addSubForm.innerHTML =
      '<input type="text" class="tool-input" placeholder="Add a subtask and press Enter" maxlength="140" required>' +
      '<button type="submit" class="tool-btn">+ Add</button>';
    var addSubInput = addSubForm.querySelector('input');
    addSubForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var subText = addSubInput.value.trim();
      if (!subText) return;
      task.subtasks.push({ id: uid('subtask'), text: subText, done: false, createdAt: Date.now(), updatedAt: Date.now(), notes: [] });
      state.openTaskIds.add(task.id);
      saveNodes();
      renderTree();
    });
    inner.appendChild(addSubForm);

    wrap.appendChild(inner);
    li.appendChild(wrap);

    return li;
  }

  function buildSubtaskRow(parentTask, subtask) {
    ensureTaskShape(subtask);
    var li = document.createElement('li');
    li.className = 'tk-subtask-row' + (subtask.done ? ' done' : '');
    li.draggable = true;
    li.dataset.taskId = subtask.id;

    li.addEventListener('dragstart', function (e) {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', subtask.id);
      requestAnimationFrame(function () { li.classList.add('dragging'); });
    });
    li.addEventListener('dragend', function (e) {
      e.stopPropagation();
      li.classList.remove('dragging');
    });

    var handle = document.createElement('span');
    handle.className = 'tk-drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.innerHTML = '&#8942;&#8942;';

    var check = document.createElement('button');
    check.type = 'button';
    check.className = 'tk-check' + (subtask.done ? ' checked' : '');
    check.setAttribute('aria-label', subtask.done ? 'Mark incomplete' : 'Mark complete');
    check.innerHTML = subtask.done ? '&#10003;' : '';
    check.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleDone(subtask);
      saveNodes();
      renderTree();
    });

    var text = document.createElement('span');
    text.className = 'tk-text';
    text.textContent = subtask.text;
    makeTextEditable(text, subtask);

    var noteBtn = buildNoteButton(subtask);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'tk-del';
    del.setAttribute('aria-label', 'Delete subtask');
    del.innerHTML = '&times;';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      subtask.deleted = true;
      subtask.updatedAt = Date.now();
      saveNodes();
      renderTree();
    });

    li.appendChild(handle);
    li.appendChild(check);
    li.appendChild(text);
    li.appendChild(noteBtn);
    li.appendChild(del);
    return li;
  }

  function wireSubtaskDragging(list, parentTask) {
    var schedule = createDragReorderer(list, '.tk-subtask-row');

    list.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.stopPropagation();
      schedule(e.clientY);
    });

    list.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var orderedIds = Array.prototype.map.call(list.querySelectorAll('.tk-subtask-row'), function (row) {
        return row.dataset.taskId;
      });
      parentTask.subtasks.sort(function (a, b) { return orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id); });
      saveNodes();
      renderTree();
    });
  }

  var NOTE_ICON_SVG =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<rect x="2.25" y="1.5" width="11.5" height="13" rx="1.6" stroke="currentColor" stroke-width="1.3"/>' +
    '<line x1="4.75" y1="5" x2="11.25" y2="5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '<line x1="4.75" y1="8" x2="11.25" y2="8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '<line x1="4.75" y1="11" x2="9" y2="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '</svg>';

  function hasNotes(task) {
    return !!(task.notes && task.notes.some(function (n) { return n.text && n.text.trim().length > 0; }));
  }

  function buildNoteButton(task) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tk-note-btn' + (hasNotes(task) ? ' has-notes' : '');
    btn.setAttribute('aria-label', 'Task notes');
    btn.title = 'Notes';
    btn.innerHTML = NOTE_ICON_SVG;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      openNotesDialog(task);
    });
    return btn;
  }

  /* ---------------- Notes dialog ---------------- */

  var notesDialogEl, notesTitleEl, notesTabsEl, notesTextareaEl, notesEmptyEl, notesDeleteBtn;
  var notesCurrentTask = null;
  var notesActiveIndex = 0;

  function openNotesDialog(task) {
    if (!task.notes) task.notes = [];
    notesCurrentTask = task;
    notesActiveIndex = task.notes.length > 0 ? 0 : -1;
    renderNotesDialog();
    if (typeof notesDialogEl.showModal === 'function') {
      notesDialogEl.showModal();
    } else {
      notesDialogEl.setAttribute('open', '');
    }
    if (notesActiveIndex === -1) {
      addNoteTab();
    } else {
      notesTextareaEl.focus();
    }
  }

  function renderNotesDialog() {
    var task = notesCurrentTask;
    if (!task) return;
    notesTitleEl.textContent = task.text;

    notesTabsEl.innerHTML = '';
    task.notes.forEach(function (note, idx) {
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tk-notes-tab' + (idx === notesActiveIndex ? ' active' : '');
      tab.textContent = 'Note ' + (idx + 1);
      tab.addEventListener('click', function () {
        commitTextarea();
        notesActiveIndex = idx;
        renderNotesDialog();
        notesTextareaEl.focus();
      });
      notesTabsEl.appendChild(tab);
    });

    var addTab = document.createElement('button');
    addTab.type = 'button';
    addTab.className = 'tk-notes-tab-add';
    addTab.setAttribute('aria-label', 'Add another note');
    addTab.title = 'Add another note';
    addTab.innerHTML = '&#43;';
    addTab.addEventListener('click', function () {
      commitTextarea();
      addNoteTab();
    });
    notesTabsEl.appendChild(addTab);

    var hasAny = task.notes.length > 0 && notesActiveIndex > -1;
    notesTextareaEl.style.display = hasAny ? 'block' : 'none';
    notesEmptyEl.style.display = hasAny ? 'none' : 'block';
    notesDeleteBtn.style.visibility = hasAny ? 'visible' : 'hidden';

    if (hasAny) {
      notesTextareaEl.value = task.notes[notesActiveIndex].text || '';
    }
  }

  function commitTextarea() {
    if (!notesCurrentTask || notesActiveIndex === -1) return;
    var note = notesCurrentTask.notes[notesActiveIndex];
    if (note) { note.text = notesTextareaEl.value; notesCurrentTask.updatedAt = Date.now(); }
  }

  function addNoteTab() {
    if (!notesCurrentTask) return;
    notesCurrentTask.notes.push({ id: uid('note'), text: '' });
    notesActiveIndex = notesCurrentTask.notes.length - 1;
    renderNotesDialog();
    notesTextareaEl.focus();
  }

  /* ---------------- All Tasks side panel ---------------- */

  function syncPriorityOrder(allItems) {
    var allIds = allItems.map(function (item) { return item.task.id; });
    state.priorityOrder = state.priorityOrder.filter(function (id) { return allIds.indexOf(id) !== -1; });
    allIds.forEach(function (id) {
      if (state.priorityOrder.indexOf(id) === -1) state.priorityOrder.push(id);
    });
  }

  var sidePanelTab = 'active'; // 'active' | 'completed'

  function renderSidePanel() {
    var all = collectAllTasks();
    syncPriorityOrder(all);

    var byId = {};
    all.forEach(function (item) { byId[item.task.id] = item; });
    var orderedAll = state.priorityOrder.map(function (id) { return byId[id]; }).filter(Boolean);

    var activeItems = orderedAll.filter(function (item) { return !item.task.done; });
    // Completed tab: most-recently-finished first, so checking a task off
    // auto-moves it straight to the top of that list.
    var completedItems = orderedAll.filter(function (item) { return item.task.done; })
      .sort(function (a, b) { return (b.task.completedAt || 0) - (a.task.completedAt || 0); });

    var countEl = document.getElementById('tkSidePanelCount');
    countEl.textContent = orderedAll.length === 0 ? '' : (completedItems.length + ' / ' + orderedAll.length + ' done');

    var hintEl = document.getElementById('tkSideHint');
    if (hintEl) {
      hintEl.textContent = sidePanelTab === 'completed'
        ? 'Most recently completed first. Click a task to jump to it in the tree.'
        : 'Drag ⋮⋮ to prioritize. Click a task to jump to it in the tree.';
    }

    var listEl = document.getElementById('tkSidePanelList');
    listEl.innerHTML = '';

    var shown = sidePanelTab === 'completed' ? completedItems : activeItems;

    if (shown.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'tk-empty-state';
      empty.textContent = sidePanelTab === 'completed'
        ? 'No completed tasks yet.'
        : "No tasks yet — add tasks in the tree and they'll show up here.";
      listEl.appendChild(empty);
      return;
    }

    shown.forEach(function (item, idx) {
      listEl.appendChild(buildPriorityRow(item, idx, sidePanelTab === 'completed'));
    });

    if (sidePanelTab !== 'completed') wirePriorityDragging(listEl);
  }

  function buildPriorityRow(item, idx, noDrag) {
    var task = item.task;
    var li = document.createElement('li');
    li.className = 'tk-priority-row' + (task.done ? ' done' : '');
    li.draggable = !noDrag;
    li.dataset.taskId = task.id;

    if (!noDrag) {
      li.addEventListener('dragstart', function (e) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.id);
        requestAnimationFrame(function () { li.classList.add('dragging'); });
      });
      li.addEventListener('dragend', function () { li.classList.remove('dragging'); });
    }

    var handle = document.createElement('span');
    handle.className = 'tk-drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.innerHTML = noDrag ? '' : '&#8942;&#8942;';

    var rank = document.createElement('span');
    rank.className = 'tk-priority-rank';
    rank.textContent = noDrag ? '' : (idx + 1) + '.';

    var check = document.createElement('button');
    check.type = 'button';
    check.className = 'tk-check' + (task.done ? ' checked' : '');
    check.setAttribute('aria-label', task.done ? 'Mark incomplete' : 'Mark complete');
    check.innerHTML = task.done ? '&#10003;' : '';
    check.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleDone(task);
      saveNodes();
      renderTree();
    });

    var content = document.createElement('div');
    content.className = 'tk-priority-content';
    content.innerHTML =
      '<div class="tk-priority-text">' + escapeHtml(task.text) + '</div>' +
      '<div class="tk-priority-meta">' +
        '<span class="tk-unit-pill" style="--pill-color:' + (item.unitColor || '#1565C0') + '">' + escapeHtml(item.unitName) + '</span>' +
        '<span class="tk-task-path">' + escapeHtml(item.leafName) +
          (item.parentTaskText ? ' &rsaquo; ' + escapeHtml(item.parentTaskText) : '') +
        '</span>' +
      '</div>';
    content.addEventListener('click', function () { jumpToTask(item); });

    var noteBtn = buildNoteButton(task);

    li.appendChild(handle);
    li.appendChild(rank);
    li.appendChild(check);
    li.appendChild(content);
    li.appendChild(noteBtn);
    return li;
  }

  function wirePriorityDragging(listEl) {
    var schedule = createDragReorderer(listEl, '.tk-priority-row');

    listEl.addEventListener('dragover', function (e) {
      e.preventDefault();
      schedule(e.clientY);
    });

    listEl.addEventListener('drop', function (e) {
      e.preventDefault();
      state.priorityOrder = Array.prototype.map.call(listEl.querySelectorAll('.tk-priority-row'), function (row) {
        return row.dataset.taskId;
      });
      savePriorityOrder();
      renderSidePanel();
    });
  }

  function flashHighlight(el) {
    if (!el) return;
    el.classList.remove('tk-flash-target');
    void el.offsetWidth;
    el.classList.add('tk-flash-target');
    setTimeout(function () { el.classList.remove('tk-flash-target'); }, 1200);
  }

  function jumpToTask(item) {
    ancestorChain(item.leafId).forEach(function (id) { state.openIds.add(id); });
    state.openIds.add(item.leafId);
    if (item.parentTaskId) { state.openTaskIds.add(item.parentTaskId); }
    renderTree();
    requestAnimationFrame(function () {
      var taskLi = document.querySelector('#tkTreeRoot li[data-task-id="' + item.task.id + '"]');
      var target = taskLi && (taskLi.querySelector('.tk-task-head') || (taskLi.classList.contains('tk-subtask-row') ? taskLi : null));
      var scrollTarget = target || taskLi || document.querySelector('li[data-id="' + item.leafId + '"] > .tk-row');
      if (!scrollTarget) return;
      scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flashHighlight(target || scrollTarget);
    });
  }

  /* ---------------- Init ---------------- */

  function initTasks() {
    notesDialogEl = document.getElementById('tkNotesDialog');
    notesTitleEl = document.getElementById('tkNotesDialogTitle');
    notesTabsEl = document.getElementById('tkNotesTabs');
    notesTextareaEl = document.getElementById('tkNotesTextarea');
    notesEmptyEl = document.getElementById('tkNotesEmpty');
    notesDeleteBtn = document.getElementById('tkNotesDeleteBtn');

    notesTextareaEl.addEventListener('input', commitTextarea);

    notesDeleteBtn.addEventListener('click', function () {
      if (!notesCurrentTask || notesActiveIndex === -1) return;
      notesCurrentTask.notes.splice(notesActiveIndex, 1);
      notesActiveIndex = notesCurrentTask.notes.length > 0 ? Math.min(notesActiveIndex, notesCurrentTask.notes.length - 1) : -1;
      renderNotesDialog();
    });

    document.getElementById('tkNotesDialogClose').addEventListener('click', function () {
      notesDialogEl.close();
    });

    notesDialogEl.addEventListener('click', function (e) {
      if (e.target === notesDialogEl) notesDialogEl.close();
    });

    notesDialogEl.addEventListener('close', function () {
      commitTextarea();
      saveNodes();
      notesCurrentTask = null;
      notesActiveIndex = 0;
      renderTree();
    });

    document.querySelectorAll('.tk-side-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        sidePanelTab = btn.dataset.tab;
        document.querySelectorAll('.tk-side-tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
        renderSidePanel();
      });
    });

    document.getElementById('tkExpandAllBtn').addEventListener('click', function () {
      collectAllIds().forEach(function (id) { state.openIds.add(id); });
      renderTree();
    });
    document.getElementById('tkCollapseAllBtn').addEventListener('click', function () {
      state.openIds.clear();
      renderTree();
    });

    renderTree();
  }

  window.reloadTasksFromStore = function () {
    state.nodes = tkGet('nodes', null) || buildInitialNodes();
    state.priorityOrder = tkGet('priorityOrder', []);
    renderTree();
  };

  // Read-only snapshot of not-done tasks/subtasks for other tabs (Planner) to
  // list and drag from. Always reflects this module's live in-memory state.
  window.getActiveTaskItems = function () {
    return collectAllTasks()
      .filter(function (item) { return !item.task.done; })
      .map(function (item) {
        return {
          id: item.task.id,
          text: item.task.text,
          unitName: item.unitName,
          leafName: item.leafName,
          unitColor: item.unitColor,
        };
      });
  };

  document.addEventListener('DOMContentLoaded', initTasks);

})();

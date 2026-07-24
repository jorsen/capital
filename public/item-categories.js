const itemCategoriesState = { list: [] };

async function loadItemCategories() {
  itemCategoriesState.list = await api('/api/item-categories');
  refreshItemDatalist();
}

function refreshItemDatalist() {
  document.getElementById('itemCategoriesList').innerHTML = itemCategoriesState.list
    .map((c) => `<option value="${escapeHtml(c.name)}">`)
    .join('');
}

function openManageItemsModal() {
  renderItemCategoryList();
  document.getElementById('manageItemsModal').classList.remove('hidden');
}

function renderItemCategoryList() {
  const list = document.getElementById('itemCategoryList');
  const sorted = itemCategoriesState.list.slice().sort((a, b) => a.name.localeCompare(b.name));

  list.innerHTML = sorted
    .map(
      (c) => `
      <li style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;" data-category-id="${c.id}">
        <span class="item-icon-preview">${itemIconImg(c.iconUrl, c.name, 36)}</span>
        <input type="text" value="${escapeHtml(c.name)}" class="category-name-input" style="flex:1 1 160px; min-width:0;">
        <input type="text" value="${escapeHtml(c.iconUrl || '')}" class="category-icon-input" placeholder="Icon URL (optional)" style="flex:1 1 200px; min-width:0;">
        <button class="btn small" data-save-category="${c.id}">Save</button>
        <button class="icon-btn" data-delete-category="${c.id}" title="Delete item">✕</button>
      </li>`
    )
    .join('');

  list.querySelectorAll('[data-save-category]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const li = btn.closest('[data-category-id]');
      const id = li.getAttribute('data-category-id');
      const name = li.querySelector('.category-name-input').value;
      const iconUrl = li.querySelector('.category-icon-input').value;
      try {
        const updated = await api(`/api/item-categories/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ name, iconUrl }),
        });
        const cat = itemCategoriesState.list.find((c) => c.id === id);
        Object.assign(cat, updated);
        refreshItemDatalist();
        toast(`Renamed to "${updated.name}"`);
        renderItemCategoryList();
      } catch (err) {
        toast(err.message);
      }
    });
  });

  list.querySelectorAll('[data-delete-category]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-category');
      const cat = itemCategoriesState.list.find((c) => c.id === id);
      if (!confirm(`Remove "${cat.name}" from the item list?`)) return;
      await api(`/api/item-categories/${id}`, { method: 'DELETE' });
      itemCategoriesState.list = itemCategoriesState.list.filter((c) => c.id !== id);
      refreshItemDatalist();
      renderItemCategoryList();
      toast('Item removed');
    });
  });
}

document.getElementById('addItemCategoryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const category = await api('/api/item-categories', {
      method: 'POST',
      body: JSON.stringify({ name: fd.get('name') }),
    });
    itemCategoriesState.list.push(category);
    refreshItemDatalist();
    e.target.reset();
    renderItemCategoryList();
    toast(`${category.name} added`);
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('manageItemsBtnLoot').addEventListener('click', openManageItemsModal);
document.getElementById('manageItemsBtnSession').addEventListener('click', openManageItemsModal);

loadItemCategories().catch((err) => toast(err.message));

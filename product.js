document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const productId = urlParams.get('id');
    const container = document.getElementById('product-container');

    if (!productId) {
        container.innerHTML = '<div class="error-message"><h2>Produkt nicht gefunden</h2><p>Bitte wähle ein Produkt auf der Startseite aus.</p></div>';
        return;
    }

    const product = products.find(p => p.id === productId);

    if (!product) {
        container.innerHTML = '<div class="error-message"><h2>Produkt nicht gefunden</h2><p>Das gesuchte Produkt existiert leider nicht.</p></div>';
        return;
    }

    // Generate Specs HTML
    let specsHtml = '';
    for (const [key, value] of Object.entries(product.specs)) {
        specsHtml += `
            <div class="spec-item">
                <span class="spec-label">${key}</span>
                <span class="spec-value">${value}</span>
            </div>
        `;
    }

    // Inject HTML
    container.innerHTML = `
        <div class="product-gallery">
            <div class="main-image">
                <img src="${product.image}" alt="${product.name}">
            </div>
        </div>
        <div class="product-details">
            <span class="category">${product.category}</span>
            <h1>${product.name}</h1>
            <p class="price large-price">${product.price}</p>
            
            <div class="description">
                <p>${product.description}</p>
            </div>
            
            <div class="specifications">
                <h3>Spezifikationen</h3>
                <div class="specs-grid">
                    ${specsHtml}
                </div>
            </div>
            
            <div class="product-actions">
                <button class="snipcart-add-item btn-primary"
                    data-item-id="${product.id}"
                    data-item-price="${product.price.replace(',', '.').replace(' €', '')}"
                    data-item-url="${window.location.href}"
                    data-item-description="${product.shortDescription}"
                    data-item-image="${product.image}"
                    data-item-name="${product.name}">
                    <span>In den Warenkorb</span>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                </button>
                <a href="index.html#kontakt" class="btn-ghost" style="text-align:center; justify-content:center;">
                    <span>Frage stellen</span>
                </a>
            </div>
        </div>
    `;

    document.title = `${product.name} | Dubbe Funzel`;
});

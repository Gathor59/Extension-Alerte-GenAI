/**
 * Return the domain from a URL
 * @param {string} url 
 * @returns 
 */
function getDomainFromUrl(url) {
    try {
        const hostname = new URL(url).hostname;
        return hostname.replace('www.', '');
    } catch (e) {
        return url;
    }
}

/**
 * Add the domain to the local whitelist for a specific category
 * @param {string} currentUrl 
 * @param {string} category 
 */
async function addToLocalWhitelist(currentUrl, category) {
    const domain = getDomainFromUrl(currentUrl);
    // Ignorer le domaine pour toutes les catégories
    const storageKey = `ignoredDomains_${category}`;
    try {
        const result = await browser.storage.local.get(storageKey);
        const ignoredDomains = result[storageKey] || [];
        if (!ignoredDomains.includes(domain)) {
            ignoredDomains.push(domain);
            await browser.storage.local.set({ [storageKey]: ignoredDomains });
        }
    } catch (error) {
    }
}

// global variables
var url = '';
var category = '';
var message = '';
var urlinfo = '';

// url, category, message, urlinfo are passed as hash parameters
if (location.hash) {
    let hash = location.hash.substring(1);
    let params = hash.split('&');
    for (var i = 0; i < params.length; i++) {
        let param = params[i].split('=');
        if (param[0] === 'u') {
            url = decodeURIComponent(param[1]);
        } else if (param[0] === 'c') {
            category = decodeURIComponent(param[1]);
        } else if (param[0] === 'm') {
            message = decodeURIComponent(param[1]);
        } else if (param[0] === 'i') {
            urlinfo = decodeURIComponent(param[1]);
        }
    }
    document.querySelectorAll('.icon').forEach(function (icon) {
        icon.style.display = 'none';
    });
    if (document.querySelector('.icon.alert-' + category)) {
        document.querySelector('.icon.alert-' + category).style.display = 'block';
    } else {
        document.querySelector('.icon.alert-generix').style.display = 'block';
    }
}

// Disable the proceed button by default
document.getElementById('understood').addEventListener('change', function () {
    var proceedButton = document.getElementById('proceedButton');
    var dontShowAgain = document.getElementById('dontShowAgain');
    if (this.checked) {
        proceedButton.disabled = false;
        proceedButton.classList.remove('button-disabled');
        proceedButton.classList.add('button-active');
        dontShowAgain.disabled = false;
    } else {
        proceedButton.disabled = true;
        proceedButton.classList.remove('button-active');
        proceedButton.classList.add('button-disabled');
        dontShowAgain.disabled = true;
    }
});

// Proceed button : add to whitelist or add to tmp whitelist
document.getElementById('proceedButton').addEventListener('click', function () {
    var domain = getDomainFromUrl(url);
    var dontShowAgain = document.getElementById('dontShowAgain');
    if (dontShowAgain.checked) {
        addToLocalWhitelist(url, category);
        document.location.href = url;
    } else {
        const storageKey = 'tmp_ignore_' + domain;
        browser.storage.local.set({ [storageKey]: new Date().getTime() }).then(() => {
            document.location.href = url;
        });
    }
});

// Quit button : redirect to AstroHamster, the harmless space hamster
document.getElementById('quitButton').addEventListener('click', function () {
    document.location.href = 'https://www.astrohamster.com';
});

// Fill the message
document.getElementById('domain').innerText = getDomainFromUrl(url);
document.getElementById('message').innerText = message;
document.getElementById('moreinfos').setAttribute('href', urlinfo);

// Reset the tmp whitelist
browser.storage.local.set({ ['tmp_ignore_' + getDomainFromUrl(url)]: 0 });
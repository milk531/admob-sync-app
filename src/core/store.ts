import {AdMobSessions} from 'core/admob-api/admob-sessions.helper';
import {AppodealApiService} from 'core/appdeal-api/appodeal-api.service';
import {AdMobAccount} from 'core/appdeal-api/interfaces/admob-account.interface';
import {AppodealAccount} from 'core/appdeal-api/interfaces/appodeal.account.interface';
import {SyncHistory, SyncHistoryInfo} from 'core/sync-apps/sync-history';
import {SyncEvent, SyncEventsTypes, SyncReportProgressEvent} from 'core/sync-apps/sync.events';
import {BrowserWindow, ipcMain} from 'electron';
import {confirmDialog, messageDialog, openWindow, waitForNavigation} from 'lib/common';
import {getLogsList, LogFileInfo} from 'lib/sync-logs/logger';
import {action, observable, observe, set} from 'mobx';
import reSignIn = AdMobSessions.reSignIn;


export interface SyncProgress {
    id: string;
    totalApps: number;
    completedApps: number;
    failedApps: number;
    percent: number;
    lastEvent: SyncEventsTypes.ReportProgress | SyncEventsTypes.CalculatingProgress | SyncEventsTypes.Started | SyncEventsTypes.Stopped;
}

export interface AppState {
    appodealAccount: AppodealAccount;
    syncHistory: Record<AccountID, SyncHistoryInfo>;
    syncProgress: Record<AccountID, SyncProgress | undefined>
}

type AccountID = string;


export class Store {

    @observable readonly state: AppState = {
        appodealAccount: AppodealApiService.emptyAccount,
        syncHistory: {},
        syncProgress: {}
    };

    updatedID;

    constructor (
        private appodealApi: AppodealApiService
    ) {
        ipcMain.on('store', () => this.emitState());
        observe(this.state, () => this.emitState());
    }

    private emitState () {
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('store', JSON.stringify(this.state));
        });
    }

    async updateAdmobAccountsInfo (appodealAccount: AppodealAccount | null) {
        const accounts: AdMobAccount[] = appodealAccount ? appodealAccount.accounts : [];

        const histories = await Promise.all(accounts.map(account => SyncHistory.getHistory(account)));

        const syncHistory = accounts.reduce((acc, account, index) => {
            acc[account.id] = histories[index];
            return acc;
        }, {});

        set<AppState>(this.state, 'syncHistory', {...(this.state.syncHistory || {}), ...syncHistory});
    }

    async updateAdMobAccountInfo (account: Pick<AdMobAccount, 'id'>) {
        const history = await SyncHistory.getHistory(account);
        set<AppState>(this.state, 'syncHistory', {...(this.state.syncHistory || {}), [account.id]: history});
    }

    @action
    fireSyncUpdated () {
        if (this.updatedID) {
            return;
        }
        this.updatedID = setTimeout(() => {
            this.updatedID = null;
            set<AppState>(this.state, 'syncProgress', {...this.state.syncProgress});
        }, 500);
    }

    @action
    updateSyncProgress (account: AdMobAccount, event: SyncEvent) {
        switch (event.type) {
        case SyncEventsTypes.Started:
        case SyncEventsTypes.CalculatingProgress:
            this.state.syncProgress[event.accountId] = {
                id: event.id,
                totalApps: 0,
                completedApps: 0,
                failedApps: 0,
                percent: 0,
                lastEvent: event.type
            };
            return this.fireSyncUpdated();
        case SyncEventsTypes.ReportProgress:
            const pEvent = <SyncReportProgressEvent>event;
            this.state.syncProgress[event.accountId] = {
                id: event.id,
                totalApps: pEvent.total,
                completedApps: pEvent.synced,
                failedApps: pEvent.failed,
                percent: (pEvent.synced + pEvent.failed) / pEvent.total * 100,
                lastEvent: event.type
            };
            return this.fireSyncUpdated();
        case SyncEventsTypes.Stopped:
            this.state.syncProgress[event.accountId] = null;
            this.fireSyncUpdated();
            return this.updateAdMobAccountInfo(account);
        }
    }

    @action
    appodealSignIn (email: string, password: string): Promise<AppodealAccount> {
        return this.appodealApi.signIn(email, password)
            .then(() => this.appodealApi.fetchCurrentUser())
            .then(account => this.setAppodealAccount(account));
    }

    @action
    appodealFetchUser (): Promise<AppodealAccount> {
        return this.appodealApi.fetchCurrentUser().then(account => this.setAppodealAccount(account));

    }

    @action
    appodealSignOut (): Promise<AppodealAccount> {
        return this.appodealApi.signOut()
            .then(() => this.setAppodealAccount(AppodealApiService.emptyAccount));
    }

    @action
    loadSelectedAdMobAccountLogs (account: AdMobAccount): Promise<LogFileInfo[]> {
        if (!account) {
            return Promise.resolve([]);
        }
        return getLogsList(account).catch(e => {
            console.error(e);
            return [];
        });
    }

    @action
    async addAdMobAccount () {
        let account = await AdMobSessions.signIn();
        if (account) {
            let existingAccount = this.state.appodealAccount.accounts.find(acc => acc.id === account.id);
            if (!existingAccount) {
                let added = await this.appodealApi.addAdMobAccount(account);
                if (added) {
                    await this.appodealFetchUser();
                    return {
                        existingAccount: null,
                        newAccount: account
                    };
                } else {
                    throw new Error(`Can't create AdMob account`);
                }
            }
            return {
                existingAccount,
                newAccount: null
            };
        }
        return {
            existingAccount: null,
            newAccount: null
        };
    }

    @action
    setAdMobCredentials ({accountId, clientId, clientSecret}: { accountId: string, clientId: string, clientSecret: string }) {
        return this.appodealApi.setAdMobAccountCredentials(accountId, clientId, clientSecret)
            .then(async oAuthUrl => {
                let window = await openWindow(oAuthUrl, {
                    frame: true,
                    titleBarStyle: 'default',
                    width: 400,
                    minWidth: 400,
                    webPreferences: {
                        session: AdMobSessions.getSession(accountId)
                    }
                });
                if (environment.development) {
                    window.webContents.once('login', async (event, request, authInfo, callback) => {
                        let {login, password} = environment.basicAuth;
                        callback(login, password);
                    });
                }
                await waitForNavigation(window, /\/admob_plugin\/api\/v3\/oauth\/success/);
                window.close();
            })
            .then(() => this.appodealApi.fetchCurrentUser())
            .then(account => this.setAppodealAccount(account));
    }

    @action
    async setAppodealAccount (account) {
        await this.updateAdmobAccountsInfo(account);
        set<AppState>(this.state, 'appodealAccount', account);
        return account;
    }

    @action
    async reSignInAdmob (currentAccount: AdMobAccount) {
        const resultAccount = await reSignIn(currentAccount);
        if (!resultAccount) {
            return;
        }
        if (resultAccount.id === currentAccount.id) {
            return await this.updateAdMobAccountInfo(currentAccount);
        }

        const existedAccount = this.state.appodealAccount.accounts.find(account => account.id === resultAccount.id);
        if (existedAccount) {
            messageDialog(`You were supposed to sign in ${currentAccount.email}, but you have signed in another account ${resultAccount.email}. Try again to sign In.`);
            return;
        }

        const addAccount = await confirmDialog(
            `You were supposed to sign in ${currentAccount.email}, but you have signed in another account ${resultAccount.email}.
Do you what to add new Account (${resultAccount.email})?`
        );

        if (addAccount) {
            // user signed in with new account
            // question
            console.log(`adding new account ${resultAccount.email}`);

            if (await this.appodealApi.addAdMobAccount(resultAccount)) {
                return await this.appodealFetchUser();
            }
            return this.updateAdMobAccountInfo(currentAccount);
        }

        console.log(`cancel adding new account. delete session`);

    }

}

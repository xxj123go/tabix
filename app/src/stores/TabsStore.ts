import { observable, action, runInAction, IReactionDisposer, reaction } from 'mobx';
import { Option, None, Some, Try } from 'funfix-core';
import { withRequest, Initializable, ViewModelLike, createViewModel } from '@vzh/mobx-stores';
import { tabsStorage, sqlHistoryStorage, Query } from 'services';
import {
  EditorTabModel,
  TabModel,
  Tab,
  isTabOfType,
  ProcessesTabModel,
  TabType,
  createTabFrom,
  MetricsTabModel,
  ServerOverviewTabModel,
  DbOverviewTabModel,
  SqlHistoryTabModel,
} from 'models';
import { DashboardUIStore } from 'stores';
import { Statistics } from 'services/api/DataDecorator';
import ApiRequestableStore from './ApiRequestableStore';

export default class TabsStore extends ApiRequestableStore<DashboardUIStore>
  implements Initializable {
  @observable
  tabs: ReadonlyArray<TabModel<Tab>> = [];

  @observable
  activeTab: Option<TabModel<Tab>> = None;

  @observable
  editedTab: Option<ViewModelLike<EditorTabModel>> = None;

  protected autosaveTimer?: number;

  protected changeTabsReaction?: IReactionDisposer;

  protected changeActiveTabReaction?: IReactionDisposer;

  init() {
    this.autosaveTimer = window.setInterval(() => {
      tabsStorage.saveTabs(this.tabs.map(_ => _.toJSON()));
    }, 30000);

    this.changeTabsReaction = reaction(
      () => this.tabs,
      tabs => tabsStorage.saveTabs(tabs.map(_ => _.toJSON()))
    );

    this.changeActiveTabReaction = reaction(
      () => this.activeTab,
      tab => {
        this.resetTabViewState();
        tabsStorage.saveActiveTabId(tab.map(t => t.id).orUndefined());
      }
    );
  }

  activeTabOfType<T extends TabModel<Tab>>(type: T['type']): Option<T> {
    return this.activeTab.flatMap(t => (isTabOfType<T>(t, type) ? Some(t) : None));
  }

  @withRequest
  async loadData() {
    // load saved tabs if empty
    const tabs = !this.tabs.length ? (await tabsStorage.getTabs()).map(createTabFrom) : this.tabs;
    // load saved active tab id if none
    const activeTabId = this.activeTab.isEmpty() ? await tabsStorage.getActiveTabId() : None;

    runInAction(() => {
      this.tabs = tabs;

      if (this.activeTab.isEmpty()) {
        this.activeTab = activeTabId
          .flatMap(id => Option.of(this.tabs.find(t => t.id === id)))
          .orElseL(() => Option.of(this.tabs.length ? this.tabs[0] : undefined));
      }

      if (this.tabs.length === 0) {
        this.openNewEditorTab();
      }
    });
  }

  @action.bound
  setActiveTab(id: string) {
    this.activeTab = Option.of(this.tabs.find(_ => _.id === id));
  }

  // todo: fix if name already exists
  private getNewTabName = () => `SQL ${this.tabs.length + 1}`;

  @action.bound
  openNewEditorTab(content?: string) {
    const newTab = EditorTabModel.from({
      title: this.getNewTabName(),
      content,
      currentDatabase: this.activeTabOfType<EditorTabModel>(TabType.Editor)
        .flatMap(t => t.currentDatabase)
        .orElse(this.rootStore.treeStore.serverStructure.map(s => s.databases[0]).map(d => d.name))
        .orUndefined(),
    });
    this.tabs = this.tabs.concat(newTab);
    this.activeTab = Some(newTab);
  }

  @action
  private openSpecialTab<T extends TabModel<any>>(type: T['type'], factory: () => T) {
    if (this.activeTab.map(_ => _.type === type).getOrElse(false)) return;

    let tab = this.tabs.find(_ => _.type === type);
    if (!tab) {
      tab = factory();
      this.tabs = this.tabs.concat(tab);
    }
    this.activeTab = Some(tab);
  }

  @action
  openProcessesTab() {
    this.openSpecialTab(TabType.Processes, () => ProcessesTabModel.from({}));
  }

  @action
  openMetricsTab() {
    this.openSpecialTab(TabType.Metrics, () => MetricsTabModel.from({}));
  }

  @action
  openServerOverviewTab() {
    this.openSpecialTab(TabType.ServerOverview, () => ServerOverviewTabModel.from({}));
  }

  @action
  openDbOverviewTab() {
    this.openSpecialTab(TabType.DbOverview, () => DbOverviewTabModel.from({}));
  }

  @action
  openSqlHistoryTab() {
    this.openSpecialTab(TabType.SqlHistory, () => SqlHistoryTabModel.from({}));
  }

  @action.bound
  removeTab(id: string) {
    this.tabs = this.tabs.filter(t => t.id !== id);
    this.activeTab = Option.of(this.tabs[this.tabs.length - 1]);
  }

  @action.bound
  insertTextToEditor(text: string, typeInsert: string = 'sql') {
    this.activeTabOfType<EditorTabModel>(TabType.Editor)
      .flatMap(t => t.codeEditor)
      .forEach(editor => editor.insertText(text, typeInsert));
  }

  async insertTableSQLDescribe(database: string, tablename: string) {
    const text = await this.api.makeTableDescribe(database, tablename);
    this.insertTextToEditor(text);
  }

  @withRequest.bound
  async saveEditedTab() {
    this.editedTab.forEach(tab => {
      tab.submit();
      tabsStorage.saveTab(tab.model.toJSON());
      this.hideSaveModal();
    });
  }

  private resetTabViewState() {
    if (this.editedTab.isEmpty()) return;
    this.editedTab.forEach(t => t.reset());
    this.editedTab = None;
  }

  @action
  showSaveModal() {
    this.activeTabOfType<EditorTabModel>(TabType.Editor).forEach(tab => {
      this.editedTab = Option.of(createViewModel(tab));
    });
  }

  @action.bound
  hideSaveModal() {
    this.resetTabViewState();
  }

  async execQueries(queries: Query[]) {
    if (!queries.length) return;

    // Save history
    sqlHistoryStorage.addItems(queries.map(_ => _.sqlOriginal));

    const extendSettings = {
      max_execution_time: 20, // ToDo:Read from Store.User.Tabix.Settings
      max_result_rows: 50000, // ToDo:Read from Store.User.Tabix.Settings
    };

    await this.activeTabOfType<EditorTabModel>(TabType.Editor)
      .map(async t => {
        const tab = t;

        const results = await Promise.all(
          queries.map(async query => {
            const q = query;
            q.extendSettings = extendSettings;

            runInAction(() => {
              this.uiStore.executingQueries = this.uiStore.executingQueries.concat(q);
            });

            try {
              const fetchResult = await this.api.fetch(q);
              return { id: q.id, result: Try.success(fetchResult) };
            } catch (ex) {
              return { id: q.id, result: Try.failure(ex) };
            } finally {
              runInAction(() => {
                this.uiStore.executingQueries = this.uiStore.executingQueries.filter(
                  eq => eq.id !== q.id
                );
              });
            }
          })
        );

        const stats = results.reduce(
          (acc, i) => {
            i.result
              .map(d => d.stats)
              .forEach(s => {
                acc.timeElapsed += s.timeElapsed;
                acc.rowsRead += s.rowsRead;
                acc.bytesRead += s.bytesRead;
              });
            return acc;
          },
          { timeElapsed: 0, rowsRead: 0, bytesRead: 0 } as Statistics
        );

        runInAction(() => {
          tab.queriesResult = Some({
            list: results,
            totalStats: stats,
          });
        });
      })
      .getOrElse(Promise.resolve());
  }

  dispose() {
    super.dispose();
    window.clearInterval(this.autosaveTimer);
  }
}
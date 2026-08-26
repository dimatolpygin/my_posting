import * as pmp from '../lib/postmypost.js';
import * as groups from '../repo/groups.js';
import * as settings from '../repo/settings.js';
import { log } from '../logger.js';

const logger = log('группы');

/**
 * Список групп Одноклассников из postmypost → в БД.
 *
 * Группа подключается в postmypost, а числовые id в панель руками не вписываются.
 *
 * Фильтр по каналу стоит в клиенте postmypost: в одном проекте могут висеть
 * аккаунты разных соцсетей, а нам нужны только ОК. Номер канала — в настройке
 * `pmp_chanel_id`, чтобы переключить соцсеть можно было без правки кода.
 *
 * Скрытые группы синхронизация не возвращает: если клиент удалил группу из панели,
 * она не должна всплывать обратно при каждом обновлении списка. Вернуть её можно
 * кнопкой в разделе «Группы» — там видно, что она скрыта, а не потеряна.
 */
export async function syncGroups() {
  const chanelId = await settings.getInt('pmp_chanel_id', pmp.CHANEL_OK);
  const accounts = await pmp.okAccounts(chanelId);
  const defaultPerDay = await settings.getInt('default_posts_per_day', 10);

  let added = 0;
  let updated = 0;
  let broken = 0;
  let hidden = 0;

  for (const account of accounts) {
    const row = await groups.upsertFromPmp(account, { postsPerDay: defaultPerDay });
    if (row.deleted_at) {
      hidden += 1;
      continue;
    }
    if (row.inserted) added += 1;
    else updated += 1;
    if (Number(account.connection_status) !== pmp.CONNECTION_OK) broken += 1;
  }

  logger.info(
    {
      канал: chanelId,
      всего: accounts.length,
      добавлено: added,
      обновлено: updated,
      отвалилось: broken,
      скрыто: hidden,
    },
    `Групп ОК в postmypost: ${accounts.length} (новых ${added}, отвалившихся ${broken}` +
      (hidden ? `, скрытых ${hidden}` : '') + ')',
  );
  return { total: accounts.length, added, updated, broken, hidden };
}

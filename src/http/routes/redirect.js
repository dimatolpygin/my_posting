import { Router } from 'express';
import * as settings from '../../repo/settings.js';
import * as clicksRepo from '../../repo/clicks.js';
import { TARGETS, isBot, visitorHash, parseClickPath, trim } from '../../lib/clicks.js';
import { log, errFields } from '../../logger.js';

const logger = log('редирект');

/**
 * Редиректор `/k/…` — единственная часть панели, открытая всему интернету
 * наравне с обложками. По ней ходят живые люди из поиска, поэтому здесь
 * два правила важнее удобства:
 *
 * **Человек уходит первым, запись в базу — вторым.** Сначала 302, потом INSERT.
 * Упавшая база не должна превращать ссылку в тупик: потерять строку статистики
 * не жалко, потерять читателя, который дошёл до нас из выдачи, — жалко.
 *
 * **302, а не 301.** Постоянный редирект браузер кеширует навсегда, и повторные
 * переходы того же человека до сервера уже не долетают.
 */
export function redirectRouter() {
  const router = Router();

  const handle = async (req, res, first, second) => {
    const parsed = parseClickPath(first, second);
    if (!parsed) {
      res.status(404).json({ error: 'Такой ссылки нет' });
      return;
    }

    let destination;
    try {
      destination = await settings.get(TARGETS[parsed.target], '');
    } catch (error) {
      logger.error(errFields(error), 'Не удалось прочитать адрес назначения из настроек');
      res.status(503).json({ error: 'Сервис временно недоступен' });
      return;
    }

    if (!destination) {
      logger.warn(
        { цель: parsed.target, настройка: TARGETS[parsed.target] },
        `Переход на «${parsed.target}», но адрес назначения не задан в настройках`,
      );
      res.status(404).json({ error: 'Ссылка ещё не настроена' });
      return;
    }

    res.redirect(302, destination);

    const userAgent = trim(req.get('user-agent'), 400);
    const bot = isBot(userAgent);
    try {
      const salt = await settings.get('click_salt', '');
      await clicksRepo.record({
        postId: parsed.postId,
        target: parsed.target,
        visitor: visitorHash(req.ip, userAgent, salt),
        userAgent,
        referer: trim(req.get('referer'), 400),
        isBot: bot,
      });
      if (!bot) {
        logger.info(
          { цель: parsed.target, пост: parsed.postId, откуда: trim(req.get('referer'), 120) },
          `Переход на «${parsed.target}»` + (parsed.postId ? ` из поста #${parsed.postId}` : ''),
        );
      }
    } catch (error) {
      // Человек уже ушёл по адресу — здесь остаётся только записать в лог.
      logger.error(
        { цель: parsed.target, пост: parsed.postId, ...errFields(error) },
        'Переход не записан в базу',
      );
    }
  };

  router.get('/k/:first', (req, res) => handle(req, res, req.params.first, null));
  router.get('/k/:first/:second', (req, res) => handle(req, res, req.params.first, req.params.second));

  return router;
}

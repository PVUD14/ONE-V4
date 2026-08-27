import { Controller, Get } from '@nestjs/common';
import { HELP_ARTICLES } from '../assistant/help-articles.js';

/**
 * The role-tagged help corpus, served to the web Help pages and the mobile
 * app's Help & FAQ. Same articles that ground the ONE Assistant, so the FAQ
 * and the assistant can never disagree. Public: this is product documentation.
 */
@Controller('/api/v1')
export class HelpController {
  @Get('/help')
  help(): Record<string, unknown> {
    return {
      articles: HELP_ARTICLES.map((article) => ({
        id: article.id,
        personas: article.personas,
        title: article.title,
        keywords: article.keywords,
        body: article.body,
      })),
    };
  }
}

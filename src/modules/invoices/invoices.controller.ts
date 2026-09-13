import { ApiBadGatewayResponse, ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProduces, ApiTags, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { ApiCommonErrors } from '../../common/openapi/common-responses';
import { ErrorResponse } from '../../common/openapi/error.response';
import { ApiPaginatedResponse } from '../../common/openapi/paginated';
import { InvoiceResponseModel } from './dto/invoice.response';
import { InvoiceSummaryResponseModel } from './dto/invoice-summary.response';
import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, StreamableFile } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { AllowExpiredTrial } from '../companies/allow-expired-trial.decorator';
import { CancelInvoiceDto } from './dto/cancel-invoice.dto';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesDto } from './dto/list-invoices.dto';
import { InvoicesService } from './invoices.service';

@ApiTags('invoices')
@ApiBearerAuth('logto')
@ApiCommonErrors()
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post()
  @ApiOperation({ summary: 'Emite uma NFS-e (síncrono). customerId OU tomador*; saveCustomer só com tomador*' })
  @ApiCreatedResponse({ type: InvoiceResponseModel, description: 'status ISSUED' })
  @ApiUnprocessableEntityResponse({ type: ErrorResponse, description: 'Sem certificado / vencido, ou nota rejeitada pelo fisco (details.code, details.reason; nota salva como REJECTED)' })
  @ApiBadGatewayResponse({ type: ErrorResponse, description: 'API Nacional indisponível; nota fica PENDING' })
  @ApiConflictResponse({ type: ErrorResponse, description: 'Emissão concorrente; repetir' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  emit(@CurrentUser() user: AuthUser, @Body() dto: CreateInvoiceDto) {
    return this.invoices.emit(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista notas (mais recentes primeiro)' })
  @ApiPaginatedResponse(InvoiceResponseModel)
  @AllowExpiredTrial()
  findAll(@CurrentUser() user: AuthUser, @Query() query: ListInvoicesDto) {
    return this.invoices.findAll(user.id, query);
  }

  // Declared before ':id' so 'summary' is not parsed as a UUID.
  @Get('summary')
  @AllowExpiredTrial()
  @ApiOperation({ summary: 'KPIs do painel: emitido no mês e no ano (só ISSUED), contagem por status, teto anual do MEI' })
  @ApiOkResponse({ type: InvoiceSummaryResponseModel })
  getSummary(@CurrentUser() user: AuthUser) {
    return this.invoices.getSummary(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe da nota' })
  @ApiOkResponse({ type: InvoiceResponseModel })
  @AllowExpiredTrial()
  findOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.findOne(user.id, id);
  }

  @Get(':id/xml')
  @ApiOperation({ summary: 'XML da NFS-e (só ISSUED/CANCELLED)' })
  @ApiProduces('application/xml')
  @ApiOkResponse({ schema: { type: 'string', format: 'xml' } })
  @AllowExpiredTrial()
  @Header('Content-Type', 'application/xml; charset=utf-8')
  getXml(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.getXml(user.id, id);
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'DANFSe em PDF (Content-Disposition: inline)' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @AllowExpiredTrial()
  async getPdf(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const pdf = await this.invoices.getPdf(user.id, id);
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `inline; filename="nfse-${id}.pdf"` });
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancela uma nota ISSUED (motivo 15–255 chars)' })
  @ApiOkResponse({ type: InvoiceResponseModel, description: 'status CANCELLED' })
  @ApiConflictResponse({ type: ErrorResponse, description: 'Nota não está ISSUED' })
  @ApiUnprocessableEntityResponse({ type: ErrorResponse, description: 'Fisco recusou o cancelamento' })
  @AllowExpiredTrial()
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelInvoiceDto) {
    return this.invoices.cancel(user.id, id, dto.motivo);
  }
}

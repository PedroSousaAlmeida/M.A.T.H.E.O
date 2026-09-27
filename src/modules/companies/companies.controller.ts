import { ApiBearerAuth, ApiBody, ApiConflictResponse, ApiConsumes, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { ApiCommonErrors } from '../../common/openapi/common-responses';
import { ErrorResponse } from '../../common/openapi/error.response';
import { CompanyResponseModel } from './dto/company.response';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { AllowExpiredTrial } from './allow-expired-trial.decorator';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { UploadCertificateDto } from './dto/upload-certificate.dto';

const MAX_PFX_BYTES = 10 * 1024;

@ApiTags('companies')
@ApiBearerAuth('logto')
@ApiCommonErrors()
@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Post()
  @ApiOperation({ summary: 'Cria a empresa do usuário (uma vez); inicia o trial de 30 dias' })
  @ApiCreatedResponse({ type: CompanyResponseModel })
  @ApiConflictResponse({ type: ErrorResponse, description: 'Usuário já tem empresa ou CNPJ já cadastrado' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCompanyDto) {
    return this.companies.create(user.id, dto);
  }

  @Get('me')
  @ApiOperation({ summary: 'Empresa do usuário (404 = ainda não cadastrou → onboarding)' })
  @ApiOkResponse({ type: CompanyResponseModel })
  @AllowExpiredTrial()
  findMine(@CurrentUser() user: AuthUser) {
    return this.companies.findMine(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Atualiza dados da empresa (cnpj não muda)' })
  @ApiOkResponse({ type: CompanyResponseModel })
  @AllowExpiredTrial()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateCompanyDto) {
    return this.companies.update(user.id, dto);
  }

  @Put('me/certificate')
  @ApiOperation({ summary: 'Envia o certificado A1 (.pfx + senha)' })
  @ApiOkResponse({ type: CompanyResponseModel })
  @ApiUnprocessableEntityResponse({ type: ErrorResponse, description: 'Arquivo inválido ou senha errada' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file', 'password'], properties: { file: { type: 'string', format: 'binary', description: 'Certificado A1 (.pfx, máx. 10 KB)' }, password: { type: 'string' } } } })
  @AllowExpiredTrial()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PFX_BYTES, files: 1 } }))
  setCertificate(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadCertificateDto,
  ) {
    if (!file) throw new BadRequestException('file is required (.pfx)');
    return this.companies.setCertificate(user.id, file.buffer, dto.password);
  }
}
